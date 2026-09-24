/**
 * Postgres implementation of ReadImpl and WriteImpl: one method per suite test.
 * Built on the same SqlExecutor and query builders the shared SQL suite uses.
 */

import { DIALECTS } from '../../src/sql/dialect.ts';
import { buildAgg, buildJson, buildRead, buildText, tableNames } from '../../src/sql/queries.ts';
import { columnNames, rowToArray, TABLES } from '../../src/suite/schema.ts';
import type { DocShape } from '../../src/types/config.type.ts';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { QueryKind, ReadImpl, RunOut, SuiteAdapter, WriteImpl } from '../../src/types/specs.type.ts';
import type { SqlExecutor } from '../../src/types/sql-suite.type.ts';

export interface PostgresImplOptions {
  /** `dataset.tablePrefix` from the suite config. */
  prefix: string;
  /** `reads.r10.docShape`, needed to render nested JSON filters. */
  docShape: DocShape;
}

export function createPostgresImpl(
  ex: SqlExecutor,
  opts: PostgresImplOptions,
): { read: ReadImpl; write: WriteImpl } {
  const d = DIALECTS.postgres;
  const names = tableNames(opts.prefix);
  const physical = (table: SuiteTable): string => `${opts.prefix}${table}`;

  const insertOne = async (table: SuiteTable, row: SuiteRow): Promise<void> => {
    const placeholders = TABLES[table]
      .map((c, i) => `${d.ph(i + 1)}${c.type === 'json' ? '::jsonb' : ''}`)
      .join(', ');
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

type ReadTest = 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r8';

/**
 * The shared SQL suite with its reads and writes routed through the per-test
 * ReadImpl / WriteImpl. Everything else (schema, indexes, EXPLAIN) is the base suite's.
 */
export function withPostgresImpl(base: SuiteAdapter, ex: SqlExecutor): SuiteAdapter {
  let impl: ReturnType<typeof createPostgresImpl> | null = null;
  const current = (): ReturnType<typeof createPostgresImpl> => {
    if (!impl) throw new Error('postgres suite used before resetSchema()');
    return impl;
  };

  const runRead = (q: QueryKind): Promise<RunOut> => {
    const { read } = current();
    switch (q.kind) {
      case 'agg':
        return read.r7(q.spec);
      case 'text':
        return read.r9(q.spec);
      case 'json':
        return read.r10(q.spec);
      case 'read':
        // The test id on the spec picks the method; the spec is already narrowed by the builder.
        return read[q.spec.test as ReadTest](q.spec as never);
    }
  };

  return {
    ...base,

    async resetSchema(cfg, opts) {
      await base.resetSchema(cfg, opts);
      impl = createPostgresImpl(ex, {
        prefix: cfg.dataset.tablePrefix,
        docShape: cfg.reads.r10.docShape,
      });
    },

    // Every plain single-row insert in the suite is a write test; the table names the test.
    insertOne(table, row) {
      const { write } = current();
      if (table === 'w_uk') return write.w2(table, row);
      if (table === 'w_docs') return write.w4(table, row);
      return write.w1(table, row);
    },

    bulkInsert: (table, rows) => (rows.length === 0 ? Promise.resolve() : current().write.w3(table, rows)),

    run: runRead,
  };
}
