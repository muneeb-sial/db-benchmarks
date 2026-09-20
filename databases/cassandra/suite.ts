/**
 * Cassandra implementation of the benchmark suite.
 *
 * Cassandra is a partitioned key-value/wide-column store, so most of the suite
 * is honestly N/A there, and every N/A carries its reason in the results:
 *
 *   - joins and cross-partition GROUP BY do not exist (all three shapes beyond
 *     `simple`, and three of the R7 aggregations)
 *   - there is no OFFSET
 *   - ORDER BY works only on clustering columns, so sort / top-N is N/A
 *   - text search needs analyzed SAI indexes that are not configured here
 *   - there is no JSON document type
 *
 * What it does run: single and batch inserts (W1, W3), unique-key inserts
 * through LWT `IF NOT EXISTS` (W2), unfiltered reads with limit and token
 * paging (R1, R4), key lookups (R5), and filtered reads through Storage-Attached
 * Indexes (R2 email, R6 created_at) or ALLOW FILTERING (R3, non-indexed).
 */

import cassandra from 'cassandra-driver';
import { columnNames, type SuiteRow, type SuiteTable } from '../../src/suite/schema.ts';
import {
  OK,
  na,
  type ExplainOut,
  type Feature,
  type QueryKind,
  type ReadSpec,
  type RunOut,
  type SuiteAdapter,
  type Support,
} from '../../src/suite/specs.ts';

const LOAD_CONCURRENCY = 128;
const USER_COLS = 'id, email, name, score, created_at';

class UniqueViolation extends Error {}

const noRows: RunOut = { rows: 0, lastKey: null };

export function createCassandraSuite(getClient: () => cassandra.Client): SuiteAdapter {
  let prefix = 'suite_';

  const table = (t: SuiteTable): string => `${prefix}${t}`;

  const idOf = (row: cassandra.types.Row | undefined): number | null => {
    if (!row) return null;
    const v = row.get('id') as unknown;
    return typeof v === 'number' ? v : null;
  };

  /** CQL text and bound parameters for a query. */
  function cql(q: QueryKind): { text: string; params: unknown[] } {
    if (q.kind === 'agg') {
      const s = q.spec;
      const users = table('users');
      switch (s.kind) {
        case 'count-all':
          return { text: `select count(*) as n from ${users}`, params: [] };
        case 'count-indexed':
          return {
            text: `select count(*) as n from ${users} where created_at >= ? and created_at <= ?`,
            params: [s.range!.from, s.range!.to],
          };
        case 'count-nonindexed':
          return {
            text: `select count(*) as n from ${users} where score < ? allow filtering`,
            params: [s.scoreBelow!],
          };
        case 'sum':
          return { text: `select sum(views) as n from ${table('posts')}`, params: [] };
        default:
          throw new Error(`cassandra cannot run ${s.kind}`);
      }
    }
    if (q.kind !== 'read') throw new Error(`cassandra cannot run ${q.kind} queries`);
    return readCql(q.spec);
  }

  function readCql(spec: ReadSpec): { text: string; params: unknown[] } {
    const users = table('users');
    const limit = spec.limit !== null ? ` limit ${spec.limit}` : '';
    const f = spec.filter;
    switch (f.kind) {
      case 'none':
        return spec.mode === 'cursor'
          ? {
              text: `select ${USER_COLS} from ${users} where token(id) > token(?)${limit}`,
              params: [spec.after],
            }
          : { text: `select ${USER_COLS} from ${users}${limit}`, params: [] };
      case 'email':
        return { text: `select ${USER_COLS} from ${users} where email = ?${limit}`, params: [f.value] };
      case 'scoreBelow':
        // Deliberately unindexed: a full scan, which is what R3 measures.
        return {
          text: `select ${USER_COLS} from ${users} where score < ?${limit} allow filtering`,
          params: [f.value],
        };
      case 'range':
        return {
          text: `select ${USER_COLS} from ${users} where created_at >= ? and created_at <= ?${limit}`,
          params: [f.from, f.to],
        };
      case 'id':
        return { text: `select ${USER_COLS} from ${users} where id = ?`, params: [f.value] };
      case 'ids':
        return {
          text: `select ${USER_COLS} from ${users} where id in (${f.values.map(() => '?').join(', ')})`,
          params: f.values,
        };
      case 'idCap':
        throw new Error('cassandra cannot run a capped full sort');
    }
  }

  const writeCols = (t: SuiteTable): { names: string; marks: string } => {
    const names = columnNames(t);
    return { names: names.join(', '), marks: names.map(() => '?').join(', ') };
  };

  const rowValues = (t: SuiteTable, row: SuiteRow): unknown[] => columnNames(t).map((c) => row[c]);

  return {
    support(f: Feature): Support {
      switch (f.kind) {
        case 'write':
          return f.test === 'w4' ? na('Cassandra has no JSON document type') : OK;
        case 'json':
          return na('Cassandra has no JSON document type');
        case 'text':
          return na('text search needs analyzed SAI indexes, which are not configured');
        case 'agg':
          return ['count-all', 'count-indexed', 'count-nonindexed', 'sum'].includes(f.spec.kind)
            ? OK
            : na('Cassandra has no joins or cross-partition GROUP BY');
        case 'read': {
          const s = f.spec;
          if (s.shape !== 'simple') return na('Cassandra has no joins');
          if (s.mode === 'offset') return na('Cassandra has no OFFSET');
          if (s.sort) return na('Cassandra cannot ORDER BY a non-clustering column');
          switch (s.filter.kind) {
            case 'none':
            case 'id':
            case 'ids':
              return OK;
            case 'email':
            case 'scoreBelow':
            case 'range':
              return s.mode === 'limit'
                ? OK
                : na('paging over a filtered scan is not supported');
            case 'idCap':
              return na('a capped full sort needs ORDER BY');
          }
        }
      }
    },

    async resetSchema(cfg) {
      prefix = cfg.dataset.tablePrefix;
      const c = getClient();
      for (const t of ['users', 'posts', 'likes', 'documents', 'w_plain', 'w_uk', 'w_docs'] as const) {
        await c.execute(`drop table if exists ${table(t)}`);
      }

      const userColumns =
        'email text, name text, score int, created_at timestamp, bio text';
      await c.execute(`create table ${table('users')} (id int primary key, ${userColumns})`);
      await c.execute(
        `create table ${table('posts')} (id int primary key, user_id int, title text, views int, created_at timestamp)`,
      );
      await c.execute(`create table ${table('w_plain')} (id int primary key, ${userColumns})`);
      // Uniqueness in Cassandra is a primary key. email is the key here so
      // that INSERT .. IF NOT EXISTS enforces it.
      await c.execute(
        `create table ${table('w_uk')} (email text primary key, id int, name text, score int, created_at timestamp, bio text)`,
      );

      // Storage-Attached Indexes (Cassandra 5.0+): the supported way to filter
      // on non-key columns. score stays unindexed on purpose (R3, R7).
      await c.execute(
        `create custom index ${prefix}users_email_idx on ${table('users')} (email) using 'StorageAttachedIndex'`,
      );
      await c.execute(
        `create custom index ${prefix}users_created_idx on ${table('users')} (created_at) using 'StorageAttachedIndex'`,
      );
    },

    async afterLoad() {
      // Nothing to do: the SAI indexes were created before the load.
    },

    async bulkInsert(t, rows) {
      if (rows.length === 0) return;
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

    async insertOne(t, row) {
      const { names, marks } = writeCols(t);
      if (t === 'w_uk') {
        const rs = await getClient().execute(
          `insert into ${table(t)} (${names}) values (${marks}) if not exists`,
          rowValues(t, row),
          { prepare: true },
        );
        if (rs.first()?.get('[applied]') === false) throw new UniqueViolation('duplicate email');
        return;
      }
      await getClient().execute(
        `insert into ${table(t)} (${names}) values (${marks})`,
        rowValues(t, row),
        { prepare: true },
      );
    },

    isUniqueViolation: (err) => err instanceof UniqueViolation,

    async truncate(t) {
      await getClient().execute(`truncate ${table(t)}`);
    },

    async run(q): Promise<RunOut> {
      const { text, params } = cql(q);
      const rs = await getClient().execute(text, params, { prepare: true });
      if (q.kind === 'agg') return { rows: rs.rowLength > 0 ? 1 : 0, lastKey: null };
      const rows = rs.rows;
      return rows.length === 0 ? noRows : { rows: rows.length, lastKey: idOf(rows[rows.length - 1]) };
    },

    async explain(q): Promise<ExplainOut> {
      // Cassandra has no EXPLAIN. Record the statement so the plan is at least auditable.
      return { text: `Cassandra has no EXPLAIN. Statement: ${cql(q).text}`, indexUsed: null };
    },

    async createIndex() {
      throw new Error('cassandra suite has no runtime-created indexes');
    },
    async dropIndex() {
      throw new Error('cassandra suite has no runtime-created indexes');
    },
    async indexSizeBytes() {
      return null;
    },
  };
}
