/**
 * Deterministic rows. Every row is a pure function of (seed, id), so the seed
 * files are reproducible from the manifest alone, and k6 can compute valid
 * keys (emails, ids, time ranges) without asking the server.
 *
 * Planted blocks: for each configured limit L a contiguous block of L user ids
 * (and document ids) carries marker text -- `pfx{L}-`, `-mid{L}-`, `-sfx{L}`,
 * `zq{L}` in users and `k{L}` in documents -- so a search for L's marker
 * returns exactly L rows.
 *
 * Write rows (W1-W4) are built here too, on the server, so k6 sends ids rather
 * than row bodies.
 */

import type { DocShape } from '../config/config.ts';
import type { Row } from '../engine/types.ts';

export const GENERATOR_VERSION = 1;

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

export interface Block {
  limit: number;
  start: number;
  end: number;
}

export function plantedBlocks(limits: readonly number[]): Block[] {
  const blocks: Block[] = [];
  let next = 1;
  for (const limit of [...new Set(limits)].sort((a, b) => a - b)) {
    blocks.push({ limit, start: next, end: next + limit - 1 });
    next += limit;
  }
  return blocks;
}

function blockAt(blocks: readonly Block[], id: number): Block | null {
  for (const b of blocks) if (id >= b.start && id <= b.end) return b;
  return null;
}

export interface Plan {
  seed: number;
  users: number;
  posts: number;
  likes: number;
  documents: number;
  blocks: Block[];
  docShape: DocShape;
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

export function userRow(plan: Plan, id: number): Row {
  const block = blockAt(plan.blocks, id);
  return {
    id,
    email: emailOf(id),
    name: block ? `pfx${block.limit}-mid${block.limit}-${id}-sfx${block.limit}` : `n${id}`,
    score: hash32(plan.seed, id, 1) % SCORE_MAX,
    created_at: ts(id),
    bio: sentence(plan.seed, id, block ? `zq${block.limit}` : null),
  };
}

export function postRow(plan: Plan, id: number): Row {
  return {
    id,
    user_id: ((id - 1) % plan.users) + 1,
    title: `post ${id} ${WORDS[hash32(plan.seed, id, 2) % WORDS.length]}`,
    views: hash32(plan.seed, id, 3) % 10_000,
    like_count: 0,
    created_at: ts(id),
  };
}

export function likeRow(plan: Plan, id: number): Row {
  return {
    id,
    post_id: (hash32(plan.seed, id, 4) % plan.posts) + 1,
    user_id: (hash32(plan.seed, id, 5) % plan.users) + 1,
    created_at: ts(id),
  };
}

function nest(depth: number, value: string): Record<string, unknown> {
  let inner: Record<string, unknown> = { value };
  for (let d = depth; d >= 1; d--) inner = { [`l${d}`]: inner };
  return inner;
}

function buildDoc(plan: Plan, id: number, marker: string | null): Record<string, unknown> {
  const shape = plan.docShape;
  const h = (salt: number): number => hash32(plan.seed, id, 300 + salt);
  const doc: Record<string, unknown> = {
    tag: marker ?? `t${h(0) % 1000}`,
    ...nest(shape.nestedDepth, marker ?? `v${h(1) % 1000}`),
  };
  for (let f = 0; f < shape.topLevelFields; f++) doc[`f${f}`] = h(10 + f) % 10_000;
  const tags: string[] = [];
  for (let a = 0; a < shape.arraySize; a++) tags.push(a === 0 && marker ? marker : `g${h(50 + a) % 500}`);
  doc.tags = tags;
  return doc;
}

export function docRow(plan: Plan, id: number): Row {
  const block = blockAt(plan.blocks, id);
  return { id, doc: buildDoc(plan, id, block ? `k${block.limit}` : null) };
}

// ------------------------------------------------------------ write rows --

export const writeEmailOf = (id: number): string => `w${id}@bench.test`;

/** Row for the W1/W2/W3 scratch tables. `id` must be unique per insert. */
export function writeRow(plan: Plan, id: number): Row {
  return {
    id,
    email: writeEmailOf(id),
    name: `w${id}`,
    score: hash32(plan.seed, id, 6) % SCORE_MAX,
    created_at: ts(id),
    bio: sentence(plan.seed, id, null),
  };
}

/** Row for the W4 scratch table. */
export function writeDocRow(plan: Plan, id: number): Row {
  return { id, doc: buildDoc(plan, id + 1_000_000_000, null) };
}

// ------------------------------------------------------------ query terms --

export function likeTerm(pattern: 'prefix' | 'contains' | 'suffix', limit: number): string {
  if (pattern === 'prefix') return `pfx${limit}-`;
  if (pattern === 'contains') return `-mid${limit}-`;
  return `-sfx${limit}`;
}

export const fullTextTerm = (limit: number): string => `zq${limit}`;
export const jsonMarker = (limit: number): string => `k${limit}`;

/** Time range on users.created_at matching exactly `count` users, from the middle of the table. */
export function rangeFor(users: number, count: number): { from: Date; to: Date } {
  const start = Math.max(1, Math.min(Math.floor(users / 2), users - count + 1));
  return { from: ts(start), to: ts(start + count - 1) };
}
