/**
 * What differs between the SQL engines, in one place.
 *
 * Everything else (query shapes, filters, pagination modes, aggregations) is
 * written once in queries.ts and rendered through a Dialect.
 */

import type { ColType } from '../suite/schema.ts';

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

const limitOffset = (limit: number | null, offset: number): string => {
  const parts: string[] = [];
  if (limit !== null) parts.push(` limit ${limit}`);
  if (offset > 0) parts.push(` offset ${offset}`);
  return parts.join('');
};

const PG_TYPES: Record<ColType, string> = {
  int: 'int',
  varchar: 'varchar(255)',
  text: 'text',
  timestamp: 'timestamptz',
  json: 'jsonb',
};

const MYSQL_TYPES: Record<ColType, string> = {
  int: 'int',
  varchar: 'varchar(255)',
  text: 'text',
  timestamp: 'datetime(3)',
  json: 'json',
};

const MSSQL_TYPES: Record<ColType, string> = {
  int: 'int',
  varchar: 'varchar(255)',
  text: 'varchar(max)',
  timestamp: 'datetime2(3)',
  json: 'nvarchar(max)',
};

const dropIfExists = (name: string): string => `drop table if exists ${name}`;

export const DIALECTS: Record<DialectName, Dialect> = {
  postgres: {
    name: 'postgres',
    ph: (n) => `$${n}`,
    pageClause: limitOffset,
    type: (t) => PG_TYPES[t],
    dropTable: dropIfExists,
    json: true,
    fullText: true,
  },
  cockroachdb: {
    name: 'cockroachdb',
    ph: (n) => `$${n}`,
    pageClause: limitOffset,
    type: (t) => PG_TYPES[t],
    dropTable: dropIfExists,
    json: true,
    // tsvector indexes on an expression are not something this harness drives yet.
    fullText: false,
  },
  mysql: {
    name: 'mysql',
    ph: () => '?',
    pageClause: limitOffset,
    type: (t) => MYSQL_TYPES[t],
    dropTable: dropIfExists,
    json: true,
    fullText: true,
  },
  mssql: {
    name: 'mssql',
    ph: (n) => `@p${n}`,
    pageClause: (limit, offset) =>
      ` offset ${offset} rows` + (limit !== null ? ` fetch next ${limit} rows only` : ''),
    type: (t) => MSSQL_TYPES[t],
    dropTable: (name) => `if object_id('${name}', 'U') is not null drop table ${name}`,
    // SQL Server 2022 has no native JSON type, and the container image ships
    // without the full-text component.
    json: false,
    fullText: false,
  },
};
