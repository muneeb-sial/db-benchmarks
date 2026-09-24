import type { DocShape, SuiteConfig } from '../types/config.type.ts';
import type { SuiteRow } from '../types/schema.type.ts';
import type { Block, DataPlan } from '../types/data.type.ts';

/**
 * Deterministic data for the suite.
 *
 * Faker is far too slow at a million rows, so rows are pure functions of
 * (seed, id): the same id always yields the same row, in any order, on any
 * engine. That also lets tests compute expected values instead of searching.
 *
 * "Planted blocks" make match counts exact. For each configured limit L, a
 * contiguous block of L ids is reserved (100, then 1000, then 3000, ...). Rows
 * in block L carry marker text (`pfx100-`, `-mid100-`, `-sfx100`, `zq100`) and
 * documents carry `k100`, so a search for L's marker returns exactly L rows.
 * Text search and JSON tests therefore return the intended result size.
 */

export const BASE_TS = Date.UTC(2024, 0, 1);
/** created_at grows by one second per id, so a time range maps to an exact id range. */
export const ts = (id: number): Date => new Date(BASE_TS + id * 1000);

export const SCORE_MAX = 1_000_000;

export function hash32(seed: number, i: number, salt: number): number {
  let h = (seed ^ Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function plantedBlocks(limits: readonly number[]): Block[] {
  const sorted = [...new Set(limits)].sort((a, b) => a - b);
  const blocks: Block[] = [];
  let next = 1;
  for (const limit of sorted) {
    blocks.push({ limit, start: next, end: next + limit - 1 });
    next += limit;
  }
  return blocks;
}

export function blockAt(blocks: readonly Block[], id: number): Block | null {
  for (const b of blocks) if (id >= b.start && id <= b.end) return b;
  return null;
}

export function makePlan(cfg: SuiteConfig): DataPlan {
  return {
    cfg,
    seed: cfg.dataset.seed,
    blocks: plantedBlocks(cfg.limits),
    users: cfg.dataset.users,
    posts: cfg.dataset.posts,
    likes: cfg.dataset.likes,
    documents: cfg.dataset.documents,
  };
}

const WORDS = [
  'alpha', 'bravo', 'cobalt', 'delta', 'ember', 'fjord', 'garnet', 'harbor',
  'iris', 'juniper', 'kelp', 'lumen', 'meadow', 'nickel', 'onyx', 'prairie',
  'quartz', 'raven', 'sable', 'tundra', 'umber', 'vortex', 'willow', 'xenon',
  'yarrow', 'zephyr', 'amber', 'basalt', 'cedar', 'dune', 'elm', 'flint',
];

function sentence(seed: number, id: number, planted: string | null): string {
  const words: string[] = [];
  for (let k = 0; k < 8; k++) words.push(WORDS[hash32(seed, id, 100 + k) % WORDS.length]!);
  if (planted) words.splice(hash32(seed, id, 200) % (words.length + 1), 0, planted);
  return words.join(' ');
}

export const emailOf = (id: number): string => `user${id}@bench.test`;

export function userRow(plan: DataPlan, id: number): SuiteRow {
  const block = blockAt(plan.blocks, id);
  return {
    id,
    email: emailOf(id),
    name: block
      ? `pfx${block.limit}-mid${block.limit}-${id}-sfx${block.limit}`
      : `n${id}`,
    score: hash32(plan.seed, id, 1) % SCORE_MAX,
    created_at: ts(id),
    bio: sentence(plan.seed, id, block ? `zq${block.limit}` : null),
  };
}

export function postRow(plan: DataPlan, id: number): SuiteRow {
  return {
    id,
    user_id: ((id - 1) % plan.users) + 1,
    title: `post ${id} ${WORDS[hash32(plan.seed, id, 2) % WORDS.length]}`,
    views: hash32(plan.seed, id, 3) % 10_000,
    created_at: ts(id),
  };
}

export function likeRow(plan: DataPlan, id: number): SuiteRow {
  return {
    id,
    post_id: (hash32(plan.seed, id, 4) % plan.posts) + 1,
    user_id: (hash32(plan.seed, id, 5) % plan.users) + 1,
    created_at: ts(id),
  };
}

/** Root path of the deepest nested field, e.g. ['l1', 'l2', 'value']. */
export function nestedPath(shape: DocShape): string[] {
  const path: string[] = [];
  for (let d = 1; d <= shape.nestedDepth; d++) path.push(`l${d}`);
  path.push('value');
  return path;
}

export function nest(shape: DocShape, value: string): Record<string, unknown> {
  let inner: Record<string, unknown> = { value };
  for (let d = shape.nestedDepth; d >= 1; d--) inner = { [`l${d}`]: inner };
  return inner;
}

export function docRow(plan: DataPlan, id: number): SuiteRow {
  const shape = plan.cfg.reads.r10.docShape;
  const block = blockAt(plan.blocks, id);
  const marker = block ? `k${block.limit}` : null;
  const h = (salt: number): number => hash32(plan.seed, id, 300 + salt);

  const doc: Record<string, unknown> = {
    tag: marker ?? `t${h(0) % 1000}`,
    ...nest(shape, marker ?? `v${h(1) % 1000}`),
  };
  for (let f = 0; f < shape.topLevelFields; f++) doc[`f${f}`] = h(10 + f) % 10_000;

  const tags: string[] = [];
  for (let a = 0; a < shape.arraySize; a++) tags.push(a === 0 && marker ? marker : `g${h(50 + a) % 500}`);
  doc.tags = tags;

  return { id, doc };
}

/** A row for the write scratch tables. `id` must be unique per insert. */
export function writeRow(plan: DataPlan, id: number): SuiteRow {
  return {
    id,
    email: `w${id}@bench.test`,
    name: `w${id}`,
    score: hash32(plan.seed, id, 6) % SCORE_MAX,
    created_at: ts(id),
    bio: sentence(plan.seed, id, null),
  };
}

export const writeEmailOf = (id: number): string => `w${id}@bench.test`;

/** Argument for a text search of `pattern` sized to match exactly `limit` rows. */
export function likeTerm(pattern: 'prefix' | 'contains' | 'suffix', limit: number): string {
  if (pattern === 'prefix') return `pfx${limit}-%`;
  if (pattern === 'contains') return `%-mid${limit}-%`;
  return `%-sfx${limit}`;
}

export function regexTerm(pattern: 'prefix' | 'contains' | 'suffix', limit: number): string {
  if (pattern === 'prefix') return `^pfx${limit}-`;
  if (pattern === 'contains') return `-mid${limit}-`;
  return `-sfx${limit}$`;
}

export const fullTextTerm = (limit: number): string => `zq${limit}`;
export const jsonMarker = (limit: number): string => `k${limit}`;

/**
 * Time range on users.created_at that matches exactly `count` users, chosen in
 * the middle of the table so it is not biased toward either end.
 */
export function rangeFor(plan: DataPlan, count: number): { from: Date; to: Date } {
  const start = Math.max(1, Math.min(Math.floor(plan.users / 2), plan.users - count + 1));
  return { from: ts(start), to: ts(start + count - 1) };
}

/** Offset (or cursor start) for op `slot`, kept inside a result set of `span` rows. */
export function positionFor(seed: number, slot: number, span: number, limit: number | null): number {
  const room = Math.max(1, span - (limit ?? 0));
  return hash32(seed, slot, 7) % room;
}
