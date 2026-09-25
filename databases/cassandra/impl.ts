/**
 * Cassandra implementation of ReadImpl and WriteImpl: one method per suite test.
 * Tests Cassandra cannot run are N/A in suite.ts `support()`, so they never get here.
 */

import cassandra from 'cassandra-driver';
import { columnNames } from '../../src/suite/schema.ts';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { EngineImpl, ImplOptions, QueryKind, ReadImpl, RunOut, WriteImpl } from '../../src/types/specs.type.ts';
import { createCql, UniqueViolation } from './cql.ts';

const LOAD_CONCURRENCY = 128;

const noRows: RunOut = { rows: 0, lastKey: null };

const unsupported = (test: string) => (): Promise<never> =>
  Promise.reject(new Error(`cassandra cannot run ${test}`));

export function createCassandraImpl(getClient: () => cassandra.Client, opts: ImplOptions): EngineImpl {
  const table = (t: SuiteTable): string => `${opts.prefix}${t}`;
  const { cql } = createCql(table);

  const idOf = (row: cassandra.types.Row | undefined): number | null => {
    if (!row) return null;
    const v = row.get('id') as unknown;
    return typeof v === 'number' ? v : null;
  };

  const writeCols = (t: SuiteTable): { names: string; marks: string } => {
    const names = columnNames(t);
    return { names: names.join(', '), marks: names.map(() => '?').join(', ') };
  };

  const rowValues = (t: SuiteTable, row: SuiteRow): unknown[] => columnNames(t).map((c) => row[c]);

  const runQuery = async (q: QueryKind): Promise<RunOut> => {
    const { text, params } = cql(q);
    const rs = await getClient().execute(text, params, { prepare: true });
    if (q.kind === 'agg') return { rows: rs.rowLength > 0 ? 1 : 0, lastKey: null };
    const rows = rs.rows;
    return rows.length === 0 ? noRows : { rows: rows.length, lastKey: idOf(rows[rows.length - 1]) };
  };

  const insertOne = async (t: SuiteTable, row: SuiteRow): Promise<void> => {
    const { names, marks } = writeCols(t);
    await getClient().execute(
      `insert into ${table(t)} (${names}) values (${marks})`,
      rowValues(t, row),
      { prepare: true },
    );
  };

  const write: WriteImpl = {
    w1: insertOne,
    // Uniqueness is LWT `IF NOT EXISTS`; a lost race surfaces as UniqueViolation.
    w2: async (t, row) => {
      const { names, marks } = writeCols(t);
      const rs = await getClient().execute(
        `insert into ${table(t)} (${names}) values (${marks}) if not exists`,
        rowValues(t, row),
        { prepare: true },
      );
      if (rs.first()?.get('[applied]') === false) throw new UniqueViolation('duplicate email');
    },
    w3: async (t, rows) => {
      // likes and documents back only joins and JSON, which are N/A here.
      if (t === 'likes' || t === 'documents' || t === 'w_docs') return;
      const { names, marks } = writeCols(t);
      // Bounded-concurrency single-partition writes. A multi-partition BATCH is
      // the well-known Cassandra anti-pattern and trips the batch size limits.
      await cassandra.concurrent.executeConcurrent(
        getClient(),
        `insert into ${table(t)} (${names}) values (${marks})`,
        rows.map((r) => rowValues(t, r)),
        { concurrencyLevel: LOAD_CONCURRENCY },
      );
    },
    w4: unsupported('w4'),
  };

  const read: ReadImpl = {
    r1: (spec) => runQuery({ kind: 'read', spec }),
    r2: (spec) => runQuery({ kind: 'read', spec }),
    r3: (spec) => runQuery({ kind: 'read', spec }),
    r4: (spec) => runQuery({ kind: 'read', spec }),
    r5: (spec) => runQuery({ kind: 'read', spec }),
    r6: (spec) => runQuery({ kind: 'read', spec }),
    r7: (spec) => runQuery({ kind: 'agg', spec }),
    r8: unsupported('r8'),
    r9: unsupported('r9'),
    r10: unsupported('r10'),
  };

  return { read, write };
}
