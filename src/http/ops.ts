/**
 * Turns a request for a test (r1..r10, w1..w4) into one engine call.
 *
 * Values that follow from the dataset -- the R3 cutoff, R6 ranges, R9 search
 * terms, R10 markers, write rows -- are computed here from the manifest, so k6
 * only sends the knobs (shape, mode, limit, offset, ids).
 */

import type { ServerConfig } from '../config/config.ts';
import type { Engine } from '../engine/engine.ts';
import {
  INDEX_KINDS,
  JSON_VARIANTS,
  LIKE_PATTERNS,
  MODES,
  R7_VARIANTS,
  SHAPES,
  SORT_KEYS,
  type CellParams,
  type OpId,
  type OpResult,
} from '../engine/types.ts';
import { BadParams } from './errors.ts';
import { int, oneOf, positiveInt, readQuery, str, type Query } from './params.ts';
import {
  fullTextTerm,
  hash32,
  jsonMarker,
  likeTerm,
  rangeFor,
  ts,
  writeDocRow,
  writeEmailOf,
  writeRow,
  type Plan,
} from '../seed/rows.ts';

export interface Ctx {
  engine: Engine;
  cfg: ServerConfig;
  plan: Plan;
}

/** A resolved op: what to check for support, and the call to time. */
export interface Prepared {
  op: OpId;
  cell: CellParams;
  run: () => Promise<OpResult>;
}

export const READ_TESTS = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10'] as const;
export const WRITE_TESTS = ['w1', 'w2', 'w3', 'w4'] as const;

export function prepareRead(ctx: Ctx, test: string, q: Query): Prepared {
  const { engine: e, cfg, plan } = ctx;
  switch (test) {
    case 'r1': {
      const rq = readQuery(q);
      return { op: 'r1', cell: rq, run: () => e.r1Scan(rq) };
    }
    case 'r2': {
      const rq = readQuery(q);
      const email = str(q, 'email');
      return { op: 'r2', cell: rq, run: () => e.r2FindByEmail(rq, email) };
    }
    case 'r3': {
      const rq = readQuery(q);
      const cutoff = cfg.reads.r3.scoreCutoff;
      return { op: 'r3', cell: rq, run: () => e.r3FilterUnindexedScore(rq, cutoff) };
    }
    case 'r4': {
      const rq = readQuery(q);
      return { op: 'r4', cell: rq, run: () => e.r4Page(rq) };
    }
    case 'r5': {
      const kind = oneOf(q, 'kind', ['id', 'multi'] as const, 'id');
      if (kind === 'id') {
        const shape = oneOf(q, 'shape', SHAPES, 'simple');
        const id = positiveInt(q, 'id');
        if (id > plan.users) throw new BadParams(`id must be at most ${plan.users}`);
        return { op: 'r5-id', cell: { shape }, run: () => e.r5GetById(shape, id) };
      }
      // Keys are derived from (slot, size) so k6 does not ship 1000 ids per request.
      const size = positiveInt(q, 'size');
      const slot = int(q, 'slot', 0);
      const ids = new Set<number>();
      for (let k = 0; ids.size < Math.min(size, plan.users); k++) {
        ids.add(1 + (hash32(plan.seed, slot * 7919 + k, 24) % plan.users));
      }
      const list = [...ids];
      return { op: 'r5-multi', cell: {}, run: () => e.r5MultiGet(list) };
    }
    case 'r6': {
      const rq = readQuery(q);
      const { from, to } = rangeFor(plan.users, positiveInt(q, 'count', rq.limit));
      return { op: 'r6', cell: rq, run: () => e.r6CreatedAtRange(rq, from, to) };
    }
    case 'r7': {
      const variant = oneOf(q, 'variant', R7_VARIANTS);
      const span = Math.max(1, Math.floor(plan.users * cfg.reads.r7.countRangeFraction));
      const start = Math.max(1, Math.floor((plan.users - span) / 2));
      const args = { cutoff: cfg.reads.r3.scoreCutoff, from: ts(start), to: ts(start + span - 1) };
      return { op: 'r7', cell: { variant }, run: () => e.r7Aggregate(variant, args) };
    }
    case 'r8': {
      const kind = oneOf(q, 'kind', ['topn', 'fullsort'] as const, 'topn');
      if (kind === 'fullsort') {
        const cap = cfg.reads.r8.fullSortRowCap;
        return { op: 'r8-fullsort', cell: {}, run: () => e.r8FullSort(cap) };
      }
      const shape = oneOf(q, 'shape', SHAPES, 'simple');
      const key = oneOf(q, 'key', SORT_KEYS);
      const limit = positiveInt(q, 'limit');
      return { op: 'r8-topn', cell: { shape, variant: key }, run: () => e.r8TopN(shape, key, limit) };
    }
    case 'r9': {
      const kind = oneOf(q, 'kind', ['like', 'fulltext'] as const, 'like');
      const limit = plantedLimit(plan, q);
      if (kind === 'fulltext') {
        const term = fullTextTerm(limit);
        return { op: 'r9-fulltext', cell: {}, run: () => e.r9FullText(term, limit) };
      }
      const pattern = oneOf(q, 'pattern', LIKE_PATTERNS);
      const term = likeTerm(pattern, limit);
      return { op: 'r9-like', cell: { pattern }, run: () => e.r9Like(pattern, term, limit) };
    }
    case 'r10': {
      const variant = oneOf(q, 'variant', JSON_VARIANTS);
      const limit = plantedLimit(plan, q);
      const value = jsonMarker(limit);
      return { op: 'r10', cell: { variant }, run: () => e.r10Json(variant, value, limit) };
    }
    default:
      throw new BadParams(`unknown read test "${test}"; one of: ${READ_TESTS.join(', ')}`);
  }
}

export function prepareWrite(ctx: Ctx, test: string, q: Query): Prepared {
  const { engine: e, plan } = ctx;
  switch (test) {
    case 'w1': {
      const row = writeRow(plan, positiveInt(q, 'id'));
      return { op: 'w1', cell: {}, run: () => e.w1Insert(row) };
    }
    case 'w2': {
      const row = writeRow(plan, positiveInt(q, 'id'));
      // `dup` reuses an existing row's email, so the insert must hit the unique key.
      if (q.dup) row.email = writeEmailOf(positiveInt(q, 'dup'));
      return { op: 'w2', cell: {}, run: () => e.w2InsertUnique(row) };
    }
    case 'w3': {
      const start = positiveInt(q, 'start');
      const size = positiveInt(q, 'size');
      const rows = Array.from({ length: size }, (_, k) => writeRow(plan, start + k));
      return { op: 'w3', cell: {}, run: () => e.w3InsertBatch(rows) };
    }
    case 'w4': {
      const row = writeDocRow(plan, positiveInt(q, 'id'));
      return { op: 'w4', cell: {}, run: () => e.w4InsertDoc(row) };
    }
    default:
      throw new BadParams(`unknown write test "${test}"; one of: ${WRITE_TESTS.join(', ')}`);
  }
}

/** R9/R10 match planted blocks, so their limit must be one of the configured limits. */
function plantedLimit(plan: Plan, q: Query): number {
  const limit = positiveInt(q, 'limit');
  if (!plan.blocks.some((b) => b.limit === limit)) {
    throw new BadParams(`limit must be one of the planted limits: ${plan.blocks.map((b) => b.limit).join(', ')}`);
  }
  return limit;
}

/** Every op and parameter combination, with `ok` or the engine's N/A reason. */
export function coverage(engine: Engine): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (key: string, op: OpId, cell: CellParams): void => {
    out[key] = engine.support(op, cell) ?? 'ok';
  };
  for (const op of ['r1', 'r2', 'r3', 'r4', 'r6'] as const) {
    for (const shape of SHAPES) for (const mode of MODES) add(`${op} ${shape} ${mode}`, op, { shape, mode });
  }
  for (const shape of SHAPES) add(`r5 id ${shape}`, 'r5-id', { shape });
  add('r5 multi', 'r5-multi', {});
  for (const variant of R7_VARIANTS) add(`r7 ${variant}`, 'r7', { variant });
  for (const shape of SHAPES) for (const key of SORT_KEYS) add(`r8 topn ${shape} ${key}`, 'r8-topn', { shape, variant: key });
  add('r8 fullsort', 'r8-fullsort', {});
  for (const pattern of LIKE_PATTERNS) add(`r9 like ${pattern}`, 'r9-like', { pattern });
  add('r9 fulltext', 'r9-fulltext', {});
  for (const variant of JSON_VARIANTS) add(`r10 ${variant}`, 'r10', { variant });
  for (const op of ['w1', 'w2', 'w3', 'w4'] as const) add(op, op, {});
  add('like', 'like', {});
  for (const kind of INDEX_KINDS) add(`index ${kind}`, 'index', { kind });
  return out;
}
