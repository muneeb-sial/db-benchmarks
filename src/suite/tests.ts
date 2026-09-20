/**
 * The test matrix: turns features.md into runnable cells.
 *
 * A "cell" is one row of a results table (test x shape x mode x limit x
 * variant). The runner executes each cell once per concurrency level. Nothing
 * here hardcodes a number from the spec: limits, shapes, modes, batch sizes,
 * multi-get sizes and so on all come from the resolved SuiteConfig.
 *
 * Ordering matters for index tests: cells that need NO index run before cells
 * that need one, so the runner creates each index once, measures with it, and
 * drops it, rather than rebuilding it between every cell.
 */

import type { ReadMode, Shape, SuiteConfig } from './config.ts';
import {
  SCORE_MAX,
  docRow,
  emailOf,
  hash32,
  positionFor,
  rangeFor,
  writeEmailOf,
  writeRow,
  type DataPlan,
} from './data.ts';
import type { OpOut } from './runner.ts';
import type { SuiteTable } from './schema.ts';
import type {
  AggKind,
  AggSpec,
  Feature,
  Filter,
  IndexKind,
  JsonFilter,
  QueryKind,
  ReadSpec,
  SuiteAdapter,
  TextPattern,
} from './specs.ts';

export interface CellContext {
  suite: SuiteAdapter;
  cfg: SuiteConfig;
  plan: DataPlan;
}

export type CellRunner =
  | { kind: 'timed'; op: (iteration: number, worker: number) => Promise<OpOut> }
  | {
      kind: 'fixed';
      totalOps: number;
      /** Untimed setup, run before the measured work (truncate, seed). */
      prepare?: () => Promise<void>;
      op: (index: number) => Promise<OpOut>;
    }
  | {
      kind: 'traversal';
      pageSize: number;
      walk: (worker: number) => Promise<{ pageMs: number[]; rows: number }>;
    };

export interface TestCell {
  id: string;
  group: string;
  title: string;
  shape: Shape | null;
  mode: ReadMode | null;
  limit: number | null;
  variant: string | null;
  /** What to ask an engine "can you run this?". Always a representative instance. */
  feature: Feature;
  /** Representative query for EXPLAIN, or null (writes). */
  explainQuery: QueryKind | null;
  /** undefined: leave indexes alone. null: no test index. Otherwise: this index must exist. */
  needsIndex: IndexKind | null | undefined;
  /** Seed tables this cell reads, beyond users. */
  needs: SuiteTable[];
  /** Rows held in memory at once at this concurrency, checked against guards.maxInFlightRows. */
  inFlightRows: (concurrency: number) => number;
  runner: (concurrency: number) => CellRunner;
}

const TITLES: Record<string, string> = {
  w1: 'Single inserts, non-transactional, no UK check',
  w2: 'Single inserts, non-transactional, with UK check',
  w3: 'Batch inserts, non-transactional',
  w4: 'Raw document insert (JSON vs MongoDB)',
  r1: 'No filter',
  r2: 'WHERE on the unique key',
  r3: 'WHERE on a non-indexed column',
  r4: 'Full table traversal',
  r5: 'Point lookup by primary key',
  r6: 'Range query on an indexed column',
  r7: 'Aggregations',
  r8: 'Sorting and top-N',
  r9: 'Text search',
  r10: 'JSON / document queries',
};

export const ALL_TEST_IDS: readonly string[] = Object.keys(TITLES);

/** Parses --tests. null means everything. Accepts ids plus `writes` and `reads`. */
export function parseTests(input: string | undefined): Set<string> | null {
  if (!input || input.trim() === '' || input.trim() === 'all') return null;
  const out = new Set<string>();
  for (const raw of input.split(',')) {
    const token = raw.trim().toLowerCase();
    if (token === 'writes') for (const id of ALL_TEST_IDS.filter((x) => x.startsWith('w'))) out.add(id);
    else if (token === 'reads') for (const id of ALL_TEST_IDS.filter((x) => x.startsWith('r'))) out.add(id);
    else if (ALL_TEST_IDS.includes(token)) out.add(token);
    else throw new Error(`unknown test "${raw}"; known: ${ALL_TEST_IDS.join(', ')}, writes, reads, all`);
  }
  return out;
}

const needsFor = (shape: Shape): SuiteTable[] =>
  shape === 'simple' ? [] : shape === 'single-join' ? ['posts'] : ['posts', 'likes'];

/** Rows in a shape when nothing filters it: the count of its most numerous side. */
const totalRows = (plan: DataPlan, shape: Shape): number =>
  shape === 'simple' ? plan.users : shape === 'single-join' ? plan.posts : plan.likes;

const readSpec = (
  o: Pick<ReadSpec, 'test' | 'shape' | 'mode' | 'limit' | 'filter'> & Partial<ReadSpec>,
): ReadSpec => ({ offset: 0, after: 0, sort: null, ...o });

interface ReadCellArgs {
  id: string;
  shape: Shape;
  mode: ReadMode;
  limit: number | null;
  variant: string | null;
  base: ReadSpec;
  /** Rows in the (filtered) result set, so offsets and cursors stay inside it. */
  span: number;
  filterFor?: (slot: number) => Filter;
  traversal?: boolean;
}

function readOp(ctx: CellContext, base: ReadSpec, span: number, filterFor?: (slot: number) => Filter) {
  return async (iteration: number, worker: number): Promise<OpOut> => {
    // Unique per (iteration, worker) as long as there are fewer than 4096 workers.
    const slot = iteration * 4096 + worker;
    const pos = base.mode === 'limit' ? 0 : positionFor(ctx.plan.seed, slot, span, base.limit);
    const spec: ReadSpec = {
      ...base,
      filter: filterFor ? filterFor(slot) : base.filter,
      offset: base.mode === 'offset' ? pos : 0,
      after: base.mode === 'cursor' ? pos : 0,
    };
    return (await ctx.suite.run({ kind: 'read', spec })).rows;
  };
}

/** Walks the whole (bounded) table one page at a time, timing each page. */
function traversal(ctx: CellContext, base: ReadSpec, pageSize: number) {
  return async (): Promise<{ pageMs: number[]; rows: number }> => {
    const pageMs: number[] = [];
    let rows = 0;
    let after = 0;
    for (let page = 0; page < ctx.cfg.reads.r4.maxPages; page++) {
      const spec: ReadSpec = { ...base, limit: pageSize, offset: page * pageSize, after };
      const t0 = performance.now();
      const out = await ctx.suite.run({ kind: 'read', spec });
      pageMs.push(performance.now() - t0);
      rows += out.rows;
      if (out.rows < pageSize) break;
      if (base.mode === 'cursor') {
        if (out.lastKey === null) break;
        after = out.lastKey;
      }
    }
    return { pageMs, rows };
  };
}

function readCell(ctx: CellContext, a: ReadCellArgs): TestCell {
  const mid = Math.floor(a.span / 2);
  const representative: ReadSpec = {
    ...a.base,
    offset: a.mode === 'offset' ? mid : 0,
    after: a.mode === 'cursor' ? mid : 0,
  };
  const rowsPerOp = a.limit ?? ctx.cfg.reads.r8.fullSortRowCap;

  return {
    id: a.id,
    group: a.id.toUpperCase(),
    title: TITLES[a.id]!,
    shape: a.shape,
    mode: a.mode,
    limit: a.limit,
    variant: a.variant,
    feature: { kind: 'read', spec: representative },
    explainQuery: { kind: 'read', spec: representative },
    needsIndex: undefined,
    needs: needsFor(a.shape),
    inFlightRows: (c) => c * rowsPerOp,
    runner: () =>
      a.traversal
        ? { kind: 'traversal', pageSize: a.limit!, walk: traversal(ctx, a.base, a.limit!) }
        : { kind: 'timed', op: readOp(ctx, a.base, a.span, a.filterFor) },
  };
}

// ------------------------------------------------------------- R1-R4, R6 --

function coreReadCells(ctx: CellContext, want: (id: string) => boolean): TestCell[] {
  const { cfg, plan } = ctx;
  const cells: TestCell[] = [];

  for (const id of ['r1', 'r2', 'r3', 'r4', 'r6']) {
    if (!want(id)) continue;
    for (const shape of cfg.shapes) {
      const total = totalRows(plan, shape);
      for (const mode of cfg.readModes) {
        for (const limit of cfg.limits) {
          let filter: Filter = { kind: 'none' };
          let span = total;
          let filterFor: ((slot: number) => Filter) | undefined;

          if (id === 'r2') {
            // The unique key: a fresh random email per operation.
            filter = { kind: 'email', value: emailOf(1) };
            span = 1;
            filterFor = (slot) => ({
              kind: 'email',
              value: emailOf(1 + (hash32(plan.seed, slot, 9) % plan.users)),
            });
          } else if (id === 'r3') {
            // A predicate on a column with no index: a full scan by construction.
            const cutoff = cfg.reads.r3.scoreCutoff;
            filter = { kind: 'scoreBelow', value: cutoff };
            span = Math.max(1, Math.floor(total * (cutoff / SCORE_MAX)));
          } else if (id === 'r6') {
            // A created_at range sized to match `limit` users.
            const r = rangeFor(plan, limit);
            filter = { kind: 'range', from: r.from, to: r.to };
            span = limit;
          }

          const base = readSpec({ test: id, shape, mode, limit, filter });
          cells.push(
            readCell(ctx, {
              id,
              shape,
              mode,
              limit,
              variant: null,
              base,
              span,
              ...(filterFor ? { filterFor } : {}),
              // R4 offset/cursor walk the whole table. R4 "simple limit" is R1's query.
              traversal: id === 'r4' && mode !== 'limit',
            }),
          );
        }
      }
    }
  }
  return cells;
}

// -------------------------------------------------------------------- R5 --

function pointLookupCells(ctx: CellContext): TestCell[] {
  const { cfg, plan } = ctx;
  const hot = cfg.reads.r5.hotKey;
  const cells: TestCell[] = [];

  const pickId = (slot: number, hotKeys: boolean): number => {
    if (hotKeys && hash32(plan.seed, slot, 21) % 1000 < hot.hotTraffic * 1000) {
      const hotCount = Math.max(1, Math.floor(plan.users * hot.hotKeys));
      return 1 + (hash32(plan.seed, slot, 22) % hotCount);
    }
    return 1 + (hash32(plan.seed, slot, 23) % plan.users);
  };

  const add = (
    shape: Shape,
    variant: string,
    make: (slot: number) => Filter,
    representative: Filter,
  ): void => {
    const base = readSpec({ test: 'r5', shape, mode: 'limit', limit: null, filter: representative });
    cells.push({
      id: 'r5',
      group: 'R5',
      title: TITLES.r5!,
      shape,
      mode: 'limit',
      limit: null,
      variant,
      feature: { kind: 'read', spec: base },
      explainQuery: { kind: 'read', spec: base },
      needsIndex: undefined,
      needs: needsFor(shape),
      inFlightRows: (c) => c * (variant.startsWith('multiget-') ? Number(variant.slice(9)) : 100),
      runner: () => ({
        kind: 'timed',
        op: async (iteration, worker) => {
          const slot = iteration * 4096 + worker;
          const spec: ReadSpec = { ...base, filter: make(slot) };
          return (await ctx.suite.run({ kind: 'read', spec })).rows;
        },
      }),
    });
  };

  for (const shape of cfg.shapes) {
    add(shape, 'uniform', (slot) => ({ kind: 'id', value: pickId(slot, false) }), { kind: 'id', value: 1 });
  }
  if (hot.enabled) {
    add('simple', 'hot', (slot) => ({ kind: 'id', value: pickId(slot, true) }), { kind: 'id', value: 1 });
  }
  for (const n of cfg.reads.r5.multiGetSizes) {
    const size = Math.min(n, plan.users);
    add(
      'simple',
      `multiget-${n}`,
      (slot) => {
        const ids = new Set<number>();
        for (let k = 0; ids.size < size; k++) ids.add(1 + (hash32(plan.seed, slot * 7919 + k, 24) % plan.users));
        return { kind: 'ids', values: [...ids] };
      },
      { kind: 'ids', values: Array.from({ length: size }, (_, k) => k + 1) },
    );
  }
  return cells;
}

// -------------------------------------------------------------------- R7 --

function aggregationCells(ctx: CellContext): TestCell[] {
  const { cfg, plan } = ctx;
  const cutoff = cfg.reads.r3.scoreCutoff;
  const range = rangeFor(plan, Math.max(1, Math.floor(plan.users * cfg.reads.r7.countRangeFraction)));

  const defs: Array<{ kind: AggKind; shape: Shape; needs: SuiteTable[]; spec: AggSpec }> = [
    { kind: 'count-all', shape: 'simple', needs: [], spec: { kind: 'count-all' } },
    { kind: 'count-indexed', shape: 'simple', needs: [], spec: { kind: 'count-indexed', range } },
    { kind: 'count-nonindexed', shape: 'simple', needs: [], spec: { kind: 'count-nonindexed', scoreBelow: cutoff } },
    { kind: 'sum', shape: 'simple', needs: ['posts'], spec: { kind: 'sum' } },
    { kind: 'posts-per-user', shape: 'single-join', needs: ['posts'], spec: { kind: 'posts-per-user' } },
    { kind: 'likes-per-post', shape: 'single-join', needs: ['posts', 'likes'], spec: { kind: 'likes-per-post' } },
    { kind: 'likes-per-user', shape: 'multi-join', needs: ['posts', 'likes'], spec: { kind: 'likes-per-user' } },
  ];

  return defs.map((d) => ({
    id: 'r7',
    group: 'R7',
    title: TITLES.r7!,
    shape: d.shape,
    mode: null,
    limit: null,
    variant: d.kind,
    feature: { kind: 'agg', spec: d.spec } as Feature,
    explainQuery: { kind: 'agg', spec: d.spec },
    needsIndex: undefined,
    needs: d.needs,
    inFlightRows: () => 0,
    runner: () => ({
      kind: 'timed',
      op: async () => (await ctx.suite.run({ kind: 'agg', spec: d.spec })).rows,
    }),
  }));
}

// -------------------------------------------------------------------- R8 --

function sortCells(ctx: CellContext): TestCell[] {
  const { cfg, plan } = ctx;
  const cells: TestCell[] = [];
  // created_at is indexed after load; score never is.
  const columns: Array<'created_at' | 'score'> = ['created_at', 'score'];

  for (const column of columns) {
    for (const shape of cfg.shapes) {
      for (const limit of cfg.limits) {
        const base = readSpec({
          test: 'r8',
          shape,
          mode: 'limit',
          limit,
          filter: { kind: 'none' },
          sort: { column },
        });
        cells.push(readCell(ctx, { id: 'r8', shape, mode: 'limit', limit, variant: `top-n:${column}`, base, span: totalRows(plan, shape) }));
      }
    }
  }

  // Full sort, no LIMIT, over a capped slice so it stays practical.
  for (const column of columns) {
    for (const shape of cfg.shapes) {
      const base = readSpec({
        test: 'r8',
        shape,
        mode: 'limit',
        limit: null,
        filter: { kind: 'idCap', cap: cfg.reads.r8.fullSortRowCap },
        sort: { column },
      });
      cells.push(readCell(ctx, { id: 'r8', shape, mode: 'limit', limit: null, variant: `full-sort:${column}`, base, span: 1 }));
    }
  }
  return cells;
}

// -------------------------------------------------------------------- R9 --

function textCells(ctx: CellContext): TestCell[] {
  const { cfg } = ctx;
  const cells: TestCell[] = [];

  const add = (pattern: TextPattern, limit: number, variant: string, needsIndex: IndexKind | null): void => {
    const spec = { pattern, limit, indexed: needsIndex !== null };
    cells.push({
      id: 'r9',
      group: 'R9',
      title: TITLES.r9!,
      shape: 'simple',
      mode: 'limit',
      limit,
      variant,
      feature: { kind: 'text', spec },
      explainQuery: { kind: 'text', spec },
      needsIndex,
      needs: [],
      inFlightRows: (c) => c * limit,
      runner: () => ({
        kind: 'timed',
        op: async () => (await ctx.suite.run({ kind: 'text', spec })).rows,
      }),
    });
  };

  // Without any supporting index first, then with one.
  for (const pattern of ['prefix', 'contains', 'suffix'] as const) {
    for (const limit of cfg.limits) add(pattern, limit, pattern, null);
  }
  for (const limit of cfg.limits) add('prefix', limit, 'prefix+index', 'text-name');
  if (cfg.reads.r9.fullText) {
    for (const limit of cfg.limits) add('fulltext', limit, 'fulltext+index', 'text-fulltext');
  }
  return cells;
}

// ------------------------------------------------------------------- R10 --

function jsonCells(ctx: CellContext): TestCell[] {
  const { cfg } = ctx;
  const cells: TestCell[] = [];
  const filters: JsonFilter[] = ['top', 'nested', 'array'];

  const add = (filter: JsonFilter, limit: number, needsIndex: IndexKind | null): void => {
    const spec = { filter, limit, indexed: needsIndex !== null };
    cells.push({
      id: 'r10',
      group: 'R10',
      title: TITLES.r10!,
      shape: null,
      mode: 'limit',
      limit,
      variant: needsIndex ? `${filter}+index` : filter,
      feature: { kind: 'json', spec },
      explainQuery: { kind: 'json', spec },
      needsIndex,
      needs: ['documents'],
      inFlightRows: (c) => c * limit,
      runner: () => ({
        kind: 'timed',
        op: async () => (await ctx.suite.run({ kind: 'json', spec })).rows,
      }),
    });
  };

  for (const filter of filters) for (const limit of cfg.limits) add(filter, limit, null);
  for (const filter of filters) {
    const kind: IndexKind = filter === 'top' ? 'json-top' : filter === 'nested' ? 'json-nested' : 'json-array';
    for (const limit of cfg.limits) add(filter, limit, kind);
  }
  return cells;
}

// ---------------------------------------------------------------- writes --

function writeCells(ctx: CellContext, want: (id: string) => boolean): TestCell[] {
  const { cfg, plan, suite } = ctx;
  const cells: TestCell[] = [];

  const base = (id: string, variant: string | null): Omit<TestCell, 'runner' | 'inFlightRows'> => ({
    id,
    group: id.toUpperCase(),
    title: TITLES[id]!,
    shape: null,
    mode: null,
    limit: null,
    variant,
    feature: { kind: 'write', test: id as 'w1' | 'w2' | 'w3' | 'w4' },
    explainQuery: null,
    needsIndex: undefined,
    needs: [],
  });

  if (want('w1')) {
    cells.push({
      ...base('w1', null),
      inFlightRows: () => 0,
      runner: () => ({
        kind: 'fixed',
        totalOps: cfg.writes.w1.rowsPerCell,
        prepare: () => suite.truncate('w_plain'),
        op: async (index) => {
          await suite.insertOne('w_plain', writeRow(plan, index + 1));
          return 1;
        },
      }),
    });
  }

  if (want('w2')) {
    const { duplicateRatio, seedRows, rowsPerCell } = cfg.writes.w2;
    cells.push({
      ...base('w2', `duplicates:${duplicateRatio}`),
      inFlightRows: () => 0,
      runner: () => ({
        kind: 'fixed',
        totalOps: rowsPerCell,
        // Rows that exist before the timed run, so duplicates have something to collide with.
        prepare: async () => {
          await suite.truncate('w_uk');
          const seed = Array.from({ length: seedRows }, (_, k) => writeRow(plan, k + 1));
          await suite.bulkInsert('w_uk', seed);
        },
        op: async (index) => {
          const row = writeRow(plan, seedRows + 1 + index);
          if (hash32(plan.seed, index, 11) / 2 ** 32 < duplicateRatio) {
            // A unique id but an email already taken: only the UK check can reject it.
            row.email = writeEmailOf(1 + (hash32(plan.seed, index, 12) % seedRows));
          }
          await suite.insertOne('w_uk', row);
          return 1;
        },
      }),
    });
  }

  if (want('w3')) {
    for (const size of cfg.writes.w3.batchSizes) {
      cells.push({
        ...base('w3', `batch-${size}`),
        inFlightRows: (c) => c * size,
        runner: (c) => ({
          kind: 'fixed',
          // At least one batch per worker; otherwise as many as fit under the row cap.
          totalOps: Math.max(c, Math.floor(cfg.writes.w3.maxRowsPerCell / size)),
          prepare: () => suite.truncate('w_plain'),
          op: async (index) => {
            // Building the rows is not part of what is being measured.
            const rows = Array.from({ length: size }, (_, k) => writeRow(plan, index * size + k + 1));
            const t0 = performance.now();
            await suite.bulkInsert('w_plain', rows);
            return { rows: size, timeMs: performance.now() - t0 };
          },
        }),
      });
    }
  }

  if (want('w4')) {
    cells.push({
      ...base('w4', null),
      inFlightRows: () => 0,
      runner: () => ({
        kind: 'fixed',
        totalOps: cfg.writes.w4.rowsPerCell,
        prepare: () => suite.truncate('w_docs'),
        op: async (index) => {
          const doc = docRow(plan, (index % plan.documents) + 1).doc;
          await suite.insertOne('w_docs', { id: index + 1, doc });
          return 1;
        },
      }),
    });
  }

  return cells;
}

/** Every cell for the selected tests, in the order the runner should execute them. */
export function buildCells(ctx: CellContext, selection: Set<string> | null): TestCell[] {
  const want = (id: string): boolean => selection === null || selection.has(id);
  const cells: TestCell[] = [];

  cells.push(...writeCells(ctx, want));
  cells.push(...coreReadCells(ctx, want));
  if (want('r5')) cells.push(...pointLookupCells(ctx));
  if (want('r7')) cells.push(...aggregationCells(ctx));
  if (want('r8')) cells.push(...sortCells(ctx));
  if (want('r9')) cells.push(...textCells(ctx));
  if (want('r10')) cells.push(...jsonCells(ctx));
  return cells;
}
