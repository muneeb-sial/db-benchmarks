/**
 * The test matrix: every k6 run a suite will make, one Cell per test variant,
 * each run once per concurrency level. Coverage keys decide N/A per engine.
 */

import type { ServerConfig } from '../config/config.ts';
import { JSON_VARIANTS, LIKE_PATTERNS, R7_VARIANTS, SORT_KEYS, type IndexKind } from '../engine/types.ts';

export const ALL_TESTS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'w1', 'w2', 'w3', 'w4', 'like'] as const;

/** Tests whose k6 script runs for DURATION seconds (the rest do fixed work). */
const TIMED = new Set(['r1', 'r2', 'r3', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'like']);

export interface Cell {
  test: string;
  label: string;
  script: string;
  env: Record<string, string | number>;
  /** Keys into GET /:db/coverage; the cell is N/A if any is not "ok". */
  coverage: string[];
  timed: boolean;
  /** Search indexes that must exist while this cell runs (the "+index" cells). */
  needIndex: IndexKind[];
  /** Search indexes that must NOT exist (the no-index R9/R10 cells measure without them). */
  noIndex: IndexKind[];
}

type IndexNeeds = Pick<Cell, 'needIndex' | 'noIndex'>;
const none: IndexNeeds = { needIndex: [], noIndex: [] };

/**
 * @param seedLimits limits the seed planted. R9/R10 search planted markers, so
 *   they only run at limits that are in both the run's limits and the seed.
 */
export function buildCells(c: ServerConfig, tests: ReadonlySet<string>, seedLimits: readonly number[]): Cell[] {
  const out: Cell[] = [];
  const add = (test: string, label: string, env: Cell['env'], coverage: string[], idx: IndexNeeds = none): void => {
    if (tests.has(test)) out.push({ test, label, script: `${test}.js`, env, coverage, timed: TIMED.has(test), ...idx });
  };
  const planted = c.limits.filter((l) => seedLimits.includes(l));

  for (const test of ['r1', 'r2', 'r3', 'r6'] as const) {
    for (const shape of c.shapes) for (const mode of c.readModes) for (const limit of c.limits) {
      add(test, `${test} ${shape} ${mode} ${limit}`, { SHAPE: shape, MODE: mode, LIMIT: limit }, [`${test} ${shape} ${mode}`]);
    }
  }
  // R4's limit mode is R1 by definition; it walks with offset or cursor.
  for (const shape of c.shapes) for (const mode of c.readModes.filter((m) => m !== 'limit')) for (const limit of c.limits) {
    add('r4', `r4 ${shape} ${mode} ${limit}`, { SHAPE: shape, MODE: mode, LIMIT: limit, MAX_PAGES: c.reads.r4.maxPages },
      [`r4 ${shape} ${mode}`]);
  }
  for (const shape of c.shapes) {
    add('r5', `r5 id ${shape} uniform`, { KIND: 'id', SHAPE: shape }, [`r5 id ${shape}`]);
    if (c.reads.r5.hotKey.enabled) {
      add('r5', `r5 id ${shape} hot`, {
        KIND: 'id', SHAPE: shape, HOT: 1, HOT_KEYS: c.reads.r5.hotKey.hotKeys, HOT_TRAFFIC: c.reads.r5.hotKey.hotTraffic,
      }, [`r5 id ${shape}`]);
    }
  }
  for (const size of c.reads.r5.multiGetSizes) add('r5', `r5 multi ${size}`, { KIND: 'multi', SIZE: size }, ['r5 multi']);
  for (const variant of R7_VARIANTS) add('r7', `r7 ${variant}`, { VARIANT: variant }, [`r7 ${variant}`]);
  for (const shape of c.shapes) for (const key of SORT_KEYS) for (const limit of c.limits) {
    add('r8', `r8 topn ${shape} ${key} ${limit}`, { KIND: 'topn', SHAPE: shape, KEY: key, LIMIT: limit }, [`r8 topn ${shape} ${key}`]);
  }
  add('r8', 'r8 fullsort', { KIND: 'fullsort' }, ['r8 fullsort']);
  // R9: every pattern without an index, prefix again with one, full-text with its index.
  // The runner sets the index state per cell; k6 never builds or drops anything here.
  for (const limit of planted) {
    for (const pattern of LIKE_PATTERNS) {
      add('r9', `r9 like ${pattern} ${limit}`, { KIND: 'like', PATTERN: pattern, LIMIT: limit }, [`r9 like ${pattern}`],
        { needIndex: [], noIndex: ['name-prefix'] });
    }
    add('r9', `r9 like prefix ${limit} +index`, { KIND: 'like', PATTERN: 'prefix', LIMIT: limit },
      ['r9 like prefix', 'index name-prefix'], { needIndex: ['name-prefix'], noIndex: [] });
    add('r9', `r9 fulltext ${limit} +index`, { KIND: 'fulltext', LIMIT: limit },
      ['r9 fulltext', 'index fulltext'], { needIndex: ['fulltext'], noIndex: [] });
  }
  // R10: each filter without, then with, its index.
  const jsonIndex = { 'top-level': 'json-top', nested: 'json-nested', 'array-contains': 'json-array' } as const;
  for (const variant of JSON_VARIANTS) for (const limit of planted) {
    add('r10', `r10 ${variant} ${limit}`, { VARIANT: variant, LIMIT: limit }, [`r10 ${variant}`],
      { needIndex: [], noIndex: [jsonIndex[variant]] });
    add('r10', `r10 ${variant} ${limit} +index`, { VARIANT: variant, LIMIT: limit },
      [`r10 ${variant}`, `index ${jsonIndex[variant]}`], { needIndex: [jsonIndex[variant]], noIndex: [] });
  }
  add('w1', 'w1', { ROWS: c.writes.w1.rowsPerCell }, ['w1']);
  add('w2', 'w2', { ROWS: c.writes.w2.rowsPerCell, SEED_ROWS: c.writes.w2.seedRows, DUP_RATIO: c.writes.w2.duplicateRatio }, ['w2']);
  for (const size of c.writes.w3.batchSizes) add('w3', `w3 ${size}`, { SIZE: size, MAX_ROWS: c.writes.w3.maxRowsPerCell }, ['w3']);
  add('w4', 'w4', { ROWS: c.writes.w4.rowsPerCell }, ['w4']);
  add('like', 'like uniform', { CONTENTION: 'uniform' }, ['like']);
  add('like', 'like hot', { CONTENTION: 'hot' }, ['like']);
  return orderForIndexes(out);
}

/**
 * Within each test, run the no-index cells before the rest, so a suite drops
 * each search index once and rebuilds it once, instead of flipping it per
 * cell. Test order and the order inside each group are unchanged.
 */
function orderForIndexes(cells: Cell[]): Cell[] {
  const testOrder = new Map<string, number>();
  for (const c of cells) if (!testOrder.has(c.test)) testOrder.set(c.test, testOrder.size);
  return cells
    .map((c, i) => ({ c, i }))
    .sort((a, b) =>
      testOrder.get(a.c.test)! - testOrder.get(b.c.test)!
      || Number(a.c.noIndex.length === 0) - Number(b.c.noIndex.length === 0)
      || a.i - b.i)
    .map(({ c }) => c);
}
