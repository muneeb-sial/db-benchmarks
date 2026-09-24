import type { RunOut } from './specs.type.ts';
import type { ColumnDef } from './schema.type.ts';

export interface SqlExecutor {
  /** Runs a SELECT and reports the row count and the last `k_` value. */
  query(sql: string, params: unknown[]): Promise<RunOut>;
  /** Runs a statement with no parameters and no result (DDL, TRUNCATE, ANALYZE). */
  execute(sql: string): Promise<void>;
  /** Runs a parameterized write. */
  write(sql: string, params: unknown[]): Promise<void>;
  /** The engine's plan for `sql`, as text. */
  explain(sql: string, params: unknown[]): Promise<string>;
  /** Inserts rows into a physical table. Arrays follow the table's column order. */
  bulkInsert(table: string, cols: ColumnDef[], rows: unknown[][]): Promise<void>;
  isUniqueViolation(err: unknown): boolean;
  /** First column of the first row as a number, or null. */
  scalar(sql: string): Promise<number | null>;
}
