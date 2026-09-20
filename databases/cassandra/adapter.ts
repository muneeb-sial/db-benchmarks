import process from 'node:process';
import cassandra from 'cassandra-driver';
import {
  Runtime,
  Transactionality,
  type Adapter,
  type ConnectOptions,
  type CounterCheck,
  type Post,
  type TxOutcome,
  type User,
} from '../../src/core/adapter.ts';

/**
 * Cassandra runs the load and read workloads only.
 *
 * It does NOT run `like-tx`. The like operation is "insert a like AND bump a
 * counter, atomically", and Cassandra cannot express that across partitions:
 *
 *   - a logged BATCH is atomic but not isolated, and cannot mix counter and
 *     non-counter statements;
 *   - LWT (`IF NOT EXISTS`) is linearizable but single-partition only;
 *   - counter columns are non-idempotent, so a retry after a timeout
 *     double-counts.
 *
 * Any of those would be a different, weaker operation than the one every other
 * engine runs, so the harness skips it and says so rather than publishing a
 * number that looks comparable and is not. (Accord, the real cross-partition
 * transaction feature, ships in Cassandra 6, which is not GA.)
 *
 * Likewise `top-posts`: ordering by an arbitrary column needs a purpose-built
 * table in Cassandra, so there is no fair equivalent of the indexed sort the
 * SQL engines do.
 */

const DATACENTER = 'datacenter1';
const LOAD_CONCURRENCY = 128;

function unsupported(what: string): never {
  throw new Error(`cassandra does not support ${what}`);
}

export function createAdapter(): Adapter {
  let client: cassandra.Client | null = null;

  const db = (): cassandra.Client => {
    if (!client) throw new Error('cassandra adapter used before connect()');
    return client;
  };

  const run = (query: string, params: unknown[] = []) =>
    db().execute(query, params, { prepare: true });

  const newClient = (opts: ConnectOptions, keyspace?: string): cassandra.Client =>
    new cassandra.Client({
      contactPoints: [`${opts.host}:${opts.port}`],
      localDataCenter: DATACENTER,
      ...(keyspace ? { keyspace } : {}),
      ...(opts.user ? { credentials: { username: opts.user, password: opts.password } } : {}),
    });

  return {
    engine: 'cassandra',
    displayName: 'Cassandra',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    capabilities: {
      transactionality: Transactionality.None,
      caseInsensitiveLike: false,
      unsupportedWorkloads: ['like-tx', 'top-posts'],
    },
    isRetryable: () => false,

    async connect(opts: ConnectOptions) {
      // Cassandra starts with no application keyspace. Create it over a
      // throwaway connection, then reconnect bound to it.
      const bootstrap = newClient(opts);
      try {
        await bootstrap.connect();
        await bootstrap.execute(
          `create keyspace if not exists "${opts.database}" with replication = ` +
            `{'class': 'SimpleStrategy', 'replication_factor': 1}`,
        );
      } finally {
        await bootstrap.shutdown();
      }

      client = newClient(opts, opts.database);
      await client.connect();
    },

    async close() {
      await client?.shutdown();
      client = null;
    },

    async serverVersion() {
      const rs = await db().execute('select release_version from system.local');
      return String(rs.first()?.get('release_version') ?? 'unknown');
    },

    async memoryConfig() {
      // The JVM heap is not visible over CQL, so it is echoed from the
      // environment for the results file. It is set explicitly in the compose
      // file because cassandra-env.sh otherwise sizes the heap from the HOST's
      // RAM, not the container limit, and the JVM gets OOM-killed.
      return {
        maxHeap: process.env.CASSANDRA_HEAP ?? '1G (compose default)',
        note: 'set via MAX_HEAP_SIZE in docker-compose.yml',
      };
    },

    async resetSchema() {
      await db().execute('drop table if exists posts');
      await db().execute('drop table if exists users');

      await db().execute(`
        create table users (
          id          int primary key,
          first_name  text,
          last_name   text,
          email       text,
          password    text,
          age         int,
          gender      text,
          created_at  timestamp,
          updated_at  timestamp
        )`);

      // Cassandra has no unique constraint and no ordinary secondary index worth
      // benchmarking. Storage-Attached Indexes (5.0+) are the supported way to
      // filter on non-key columns, the counterpart of the SQL engines' indexes.
      await db().execute(
        `create custom index users_email_idx on users (email) using 'StorageAttachedIndex'`,
      );
      await db().execute(
        `create custom index users_age_idx on users (age) using 'StorageAttachedIndex'`,
      );

      // like_count is kept for schema parity but never written: the like
      // workload does not run on this engine.
      await db().execute(`
        create table posts (
          id          int primary key,
          user_id     int,
          title       text,
          body        text,
          like_count  int,
          created_at  timestamp,
          updated_at  timestamp
        )`);
    },

    async insertUsers(batch: readonly User[]) {
      // Bounded-concurrency single-partition writes. A multi-partition BATCH
      // is the well-known Cassandra anti-pattern and trips batch size limits.
      await cassandra.concurrent.executeConcurrent(
        db(),
        `insert into users (id, first_name, last_name, email, password, age, gender, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        batch.map((u) => [
          u.id, u.first_name, u.last_name, u.email, u.password,
          u.age, u.gender, u.created_at, u.updated_at,
        ]),
        { concurrencyLevel: LOAD_CONCURRENCY },
      );
    },

    async insertPosts(batch: readonly Post[]) {
      await cassandra.concurrent.executeConcurrent(
        db(),
        `insert into posts (id, user_id, title, body, like_count, created_at, updated_at)
         values (?, ?, ?, ?, ?, ?, ?)`,
        batch.map((p) => [
          p.id, p.user_id, p.title, p.body, p.like_count, p.created_at, p.updated_at,
        ]),
        { concurrencyLevel: LOAD_CONCURRENCY },
      );
    },

    async getUserByEmail(email: string) {
      const rs = await run('select * from users where email = ?', [email]);
      return rs.first() ?? null;
    },

    async listPosts(limit: number) {
      // Token order, not `order by id`: Cassandra cannot sort a full scan.
      const rs = await run('select * from posts limit ?', [limit]);
      return rs.rows;
    },

    async countUsersByAgeRange(min: number, max: number) {
      const rs = await run('select count(*) as total from users where age >= ? and age <= ?', [
        min,
        max,
      ]);
      // count(*) is a bigint, which the driver returns as a Long.
      return Number(String(rs.first()?.get('total') ?? 0));
    },

    async topPostsByLikes(): Promise<readonly unknown[]> {
      return unsupported('top-posts');
    },

    async likePost(): Promise<TxOutcome> {
      return unsupported('like-tx');
    },

    async verifyCounters(): Promise<CounterCheck> {
      return unsupported('counter verification (like-tx does not run here)');
    },
  };
}
