import type { Feature, Filter, IndexKind, QueryKind, ReadSpec, SuiteAdapter } from './specs.type.ts';
import type { SuiteConfig } from './config.type.ts';
import type { DataPlan } from './data.type.ts';
import type { OpOut } from './runner.type.ts';
import type { ReadMode, Shape } from './config.type.ts';
import type { SuiteTable } from './schema.type.ts';

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

export interface ReadCellArgs {
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
