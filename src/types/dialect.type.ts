import type { ColType } from './schema.type.ts';

export type DialectName = 'postgres' | 'cockroachdb' | 'mysql' | 'mssql';

export interface Dialect {
  readonly name: DialectName;
  /** Positional parameter placeholder, 1-based. */
  ph(n: number): string;
  /**
   * Trailing pagination clause, with a leading space. Both numbers are inlined:
   * they come from validated config, and some drivers cannot bind LIMIT.
   * SQL Server's OFFSET .. FETCH requires an ORDER BY, which every query has.
   */
  pageClause(limit: number | null, offset: number): string;
  type(t: ColType): string;
  dropTable(name: string): string;
  /** Native JSON document type (jsonb / JSON). */
  readonly json: boolean;
  /** Full-text search the harness knows how to drive. */
  readonly fullText: boolean;
}
