/**
 * SQL implementation of ReadImpl and WriteImpl: one method per suite test.
 * Built on the same SqlExecutor and query builders the shared SQL suite uses.
 */

import { buildAgg, buildJson, buildRead, buildText, tableNames } from './queries.ts';
import { columnNames, rowToArray, TABLES } from '../suite/schema.ts';
import type { ColumnDef, SuiteRow, SuiteTable } from '../types/schema.type.ts';
import type { Dialect } from '../types/dialect.type.ts';
import type { EngineImpl, ImplOptions, ReadImpl, RunOut, WriteImpl } from '../types/specs.type.ts';
import type { SqlExecutor } from '../types/sql-suite.type.ts';

export function createSqlImpl(d: Dialect, ex: SqlExecutor, opts: ImplOptions): EngineImpl {
  const names = tableNames(opts.prefix);
  const physical = (table: SuiteTable): string => `${opts.prefix}${table}`;
  const jsonCast = (c: ColumnDef): string =>
    c.type === 'json' && (d.name === 'postgres' || d.name === 'cockroachdb') ? '::jsonb' : '';

  const insertOne = async (table: SuiteTable, row: SuiteRow): Promise<void> => {
    const placeholders = TABLES[table].map((c, i) => `${d.ph(i + 1)}${jsonCast(c)}`).join(', ');
    await ex.write(
      `insert into ${physical(table)} (${columnNames(table).join(', ')}) values (${placeholders})`,
      rowToArray(table, row),
    );
  };

  const read = async (built: { sql: string; params: unknown[] }): Promise<RunOut> =>
    ex.query(built.sql, built.params);

  const write: WriteImpl = {
    w1: insertOne,
    // A duplicate email raises a unique violation; the runner counts it via ex.isUniqueViolation.
    w2: insertOne,
    w3: (table, rows) =>
      ex.bulkInsert(physical(table), TABLES[table], rows.map((r) => rowToArray(table, r))),
    w4: insertOne,
  };

  const readImpl: ReadImpl = {
    r1: (spec) => read(buildRead(d, names, spec)),
    r2: (spec) => read(buildRead(d, names, spec)),
    r3: (spec) => read(buildRead(d, names, spec)),
    r4: (spec) => read(buildRead(d, names, spec)),
    r5: (spec) => read(buildRead(d, names, spec)),
    r6: (spec) => read(buildRead(d, names, spec)),
    r7: (spec) => read(buildAgg(d, names, spec)),
    r8: (spec) => read(buildRead(d, names, spec)),
    r9: (spec) => read(buildText(d, names, spec)),
    r10: (spec) => read(buildJson(d, names, spec, opts.docShape)),
  };

  return { read: readImpl, write };
}
