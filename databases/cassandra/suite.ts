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
import { createCql, UniqueViolation } from './cql.ts';
import { OK, na } from '../../src/suite/specs.ts';
import type { SuiteTable } from '../../src/types/schema.type.ts';
import type { ExplainOut, Feature, RunOut, SuiteAdapter, Support } from '../../src/types/specs.type.ts';




const PROVIDED = 'reads and writes are provided by createCassandraImpl via withImpl';

export function createCassandraSuite(getClient: () => cassandra.Client): SuiteAdapter {
  let prefix = 'suite_';

  const table = (t: SuiteTable): string => `${prefix}${t}`;
  const { cql } = createCql(table);
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

    isUniqueViolation: (err) => err instanceof UniqueViolation,

    async truncate(t) {
      await getClient().execute(`truncate ${table(t)}`);
    },

    // Reads and writes are supplied per test by impl.ts, wired in by withImpl.
    bulkInsert: () => Promise.reject(new Error(PROVIDED)),
    insertOne: () => Promise.reject(new Error(PROVIDED)),
    run: (): Promise<RunOut> => Promise.reject(new Error(PROVIDED)),

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
