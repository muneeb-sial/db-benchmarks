/**
 * Logical queries and the adapter contract for the suite.
 *
 * A test describes WHAT to run (a ReadSpec, AggSpec, TextSpec or JsonSpec);
 * each engine decides HOW. SQL engines share one builder (src/sql), MongoDB
 * translates to pipelines, Cassandra implements the subset it can. Anything an
 * engine cannot do honestly is reported as N/A with a reason, never faked.
 */

import type { DocShape } from '../types/config.type.ts';
import type { Support } from '../types/specs.type.ts';
export const OK: Support = { ok: true };
export const na = (reason: string): Support => ({ ok: false, reason });

export type { DocShape };
