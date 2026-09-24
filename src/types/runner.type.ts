import type { Summary } from './stats.type.ts';

export type OpOut = number | { rows: number; timeMs?: number };

export interface Measure {
  ops: number;
  wallMs: number;
  rows: number;
  latency: Summary;
  errors: number;
  ukViolations: number;
  sampleErrors: string[];
}

export interface Common {
  concurrency: number;
  isUniqueViolation?: (err: unknown) => boolean;
}

export interface TraversalOut {
  perPageMs: number[];
  totalMs: number;
  pages: number;
  rows: number;
  wallMs: number;
  errors: number;
  sampleErrors: string[];
  /** Every page latency from every worker, for the summary statistics. */
  allPageMs: number[];
}
