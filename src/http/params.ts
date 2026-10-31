/** Query-string parsing. Anything malformed is a 400, never a silent default. */

import { BadParams } from './errors.ts';
import { MODES, SHAPES, type Mode, type ReadQuery, type Shape } from '../engine/types.ts';

export type Query = Record<string, string>;

export const getQuery = (req: Request): Query => Object.fromEntries(new URL(req.url).searchParams);

export function int(q: Query, key: string, fallback?: number): number {
  const v = q[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new BadParams(`missing query param "${key}"`);
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new BadParams(`"${key}" must be a non-negative integer (got "${v}")`);
  return n;
}

export function positiveInt(q: Query, key: string, fallback?: number): number {
  const n = int(q, key, fallback);
  if (n === 0) throw new BadParams(`"${key}" must be at least 1`);
  return n;
}

export function oneOf<T extends string>(q: Query, key: string, allowed: readonly T[], fallback?: T): T {
  const v = q[key] ?? fallback;
  if (v === undefined) throw new BadParams(`missing query param "${key}"; one of: ${allowed.join(', ')}`);
  if (!allowed.includes(v as T)) throw new BadParams(`"${key}" must be one of: ${allowed.join(', ')} (got "${v}")`);
  return v as T;
}

export function str(q: Query, key: string): string {
  const v = q[key];
  if (!v) throw new BadParams(`missing query param "${key}"`);
  return v;
}

/** shape, mode, limit, plus offset (offset mode) or after (cursor mode). */
export function readQuery(q: Query): ReadQuery {
  const shape: Shape = oneOf(q, 'shape', SHAPES, 'simple');
  const mode: Mode = oneOf(q, 'mode', MODES, 'limit');
  return {
    shape,
    mode,
    limit: positiveInt(q, 'limit'),
    offset: mode === 'offset' ? int(q, 'offset', 0) : 0,
    after: mode === 'cursor' ? int(q, 'after', 0) : 0,
  };
}
