/** Shape of the suite's results, as written into result.json. */

import type { Summary } from '../core/stats.ts';
import type { ExplainOut } from './specs.ts';

export type CellStatus = 'ok' | 'na' | 'skipped' | 'error';

export interface SuiteCellResult {
  test: string;
  group: string;
  title: string;
  shape: string | null;
  mode: string | null;
  limit: number | null;
  variant: string | null;
  concurrency: number;
  status: CellStatus;
  /** Why a cell is N/A, skipped or errored. */
  reason?: string;
  ops: number;
  wallMs: number;
  opsPerSec: number;
  rowsPerSec: number;
  /** Average rows returned per operation, to confirm the result size matches the intended limit. */
  rowsPerQuery: number;
  latencyMs: Summary | null;
  errors: number;
  /** Unique-key violations, counted separately because W2 provokes them on purpose. */
  ukViolations: number;
  sampleErrors: string[];
  /** Links to an entry in SuiteEngineResult.explain. */
  queryKey: string;
}

export interface TraversalResult {
  test: string;
  shape: string;
  mode: string;
  pageSize: number;
  concurrency: number;
  pages: number;
  rows: number;
  /** Median across workers of the time to walk the whole traversal. */
  totalMs: number;
  /** Median across workers of each page's latency, by page number. */
  perPageMs: number[];
}

export interface IndexBuild {
  kind: string;
  buildMs: number;
  sizeBytes: number | null;
}

export interface SuiteEngineResult {
  loadMs: Record<string, number>;
  cells: SuiteCellResult[];
  /** EXPLAIN (or the closest equivalent), captured once per distinct query. */
  explain: Record<string, ExplainOut>;
  indexes: IndexBuild[];
  traversals: TraversalResult[];
}

export function queryKey(
  test: string,
  shape: string | null,
  mode: string | null,
  limit: number | null,
  variant: string | null,
): string {
  return [test, shape ?? '-', mode ?? '-', limit ?? '-', variant ?? '-'].join(':');
}
