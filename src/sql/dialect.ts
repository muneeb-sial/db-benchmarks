import type { ColType } from '../types/schema.type.ts';
import type { Dialect, DialectName } from '../types/dialect.type.ts';

/**
 * What differs between the SQL engines, in one place.
 *
 * Everything else (query shapes, filters, pagination modes, aggregations) is
 * written once in queries.ts and rendered through a Dialect.
 */

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
