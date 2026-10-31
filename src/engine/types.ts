/**
 * Types shared by the router, the params parser and every engine class.
 * Only shapes and names live here -- never query text.
 */

export const SHAPES = ['simple', 'single-join', 'multi-join'] as const;
export type Shape = (typeof SHAPES)[number];

export const MODES = ['limit', 'offset', 'cursor'] as const;
export type Mode = (typeof MODES)[number];

/** A paged read. `offset` is used in offset mode, `after` (last key seen) in cursor mode. */
export interface ReadQuery {
  shape: Shape;
  mode: Mode;
  limit: number;
  offset: number;
  after: number;
}

export interface OpResult {
  rows: number;
  /** Last key of the page, so a k6 cursor walk can continue from it. */
  last?: number | null;
}

export const SEED_TABLES = ['users', 'posts', 'likes', 'documents'] as const;
export type SeedTable = (typeof SEED_TABLES)[number];

/**
 * Tables truncated before a run. `tx_likes` is the like-tx table, PK (user_id,
 * post_id); truncating it also resets posts.like_count to 0.
 */
export const SCRATCH_TABLES = ['w_plain', 'w_uk', 'w_docs', 'tx_likes'] as const;
export type ScratchTable = (typeof SCRATCH_TABLES)[number];

export type Row = Record<string, unknown>;

export const R7_VARIANTS = [
  'count-all',
  'count-indexed',
  'count-unindexed',
  'sum-views',
  'posts-per-user',
  'likes-per-post',
  'likes-per-user',
] as const;
export type R7Variant = (typeof R7_VARIANTS)[number];

export const SORT_KEYS = ['indexed', 'unindexed'] as const;
export type SortKey = (typeof SORT_KEYS)[number];

export const LIKE_PATTERNS = ['prefix', 'contains', 'suffix'] as const;
export type LikePattern = (typeof LIKE_PATTERNS)[number];

export const JSON_VARIANTS = ['top-level', 'nested', 'array-contains'] as const;
export type JsonVariant = (typeof JSON_VARIANTS)[number];

/** Secondary indexes that R9/R10 build for their "with index" cells. */
export const INDEX_KINDS = ['name-prefix', 'fulltext', 'json-top', 'json-nested', 'json-array'] as const;
export type IndexKind = (typeof INDEX_KINDS)[number];

/** Every operation the server can run. Coverage and N/A reasons are keyed by these. */
export const OP_IDS = [
  'r1', 'r2', 'r3', 'r4', 'r5-id', 'r5-multi', 'r6', 'r7', 'r8-topn', 'r8-fullsort',
  'r9-like', 'r9-fulltext', 'r10', 'w1', 'w2', 'w3', 'w4', 'like', 'index',
] as const;
export type OpId = (typeof OP_IDS)[number];

/**
 * The parameters an engine's support() sees, so it can refuse one combination
 * (e.g. joins on R1) while still running the others (the simple shape).
 */
export interface CellParams {
  shape?: Shape;
  mode?: Mode;
  variant?: string;
  pattern?: LikePattern;
  kind?: IndexKind;
}
