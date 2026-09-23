import { Client, errors } from '@elastic/elasticsearch';
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
import { createElasticsearchSuite } from './suite.ts';

/**
 * Elasticsearch runs the load and read workloads only.
 *
 * It does NOT run `like-tx`. Elasticsearch has no multi-document transaction
 * primitive at all -- not even Cassandra's weaker "atomic but not isolated"
 * logged BATCH. A single document write is atomic; two documents (the like
 * and the post's counter) never are. Publishing a number for that operation
 * would compare a real transaction on other engines against two unrelated
 * writes here, so the harness skips it and says so instead.
 *
 * `topPostsByLikes`, unlike on Cassandra, IS supported: sorting by a numeric
 * field the index already has is exactly what Elasticsearch is fast at, no
 * purpose-built table required.
 */

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504]);

function unsupported(what: string): never {
  throw new Error(`elasticsearch does not support ${what}`);
}

function statusCode(err: unknown): number | undefined {
  if (err instanceof errors.ResponseError) return err.meta.statusCode ?? undefined;
  return undefined;
}

export function createAdapter(): Adapter {
  let client: Client | null = null;

  const db = (): Client => {
    if (!client) throw new Error('elasticsearch adapter used before connect()');
    return client;
  };

  return {
    engine: 'elasticsearch',
    displayName: 'Elasticsearch',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    capabilities: {
      transactionality: Transactionality.None,
      // getUserByEmail is an exact `term` match on a keyword field, not a
      // case-folding LIKE.
      caseInsensitiveLike: false,
      unsupportedWorkloads: ['like-tx'],
    },

    isRetryable: (err) =>
      err instanceof errors.ConnectionError ||
      err instanceof errors.TimeoutError ||
      RETRYABLE_STATUSES.has(statusCode(err) ?? 0),

    suite: createElasticsearchSuite(db),

    async connect(opts: ConnectOptions) {
      client = new Client({
        node: `http://${opts.host}:${opts.port}`,
        ...(opts.user ? { auth: { username: opts.user, password: opts.password } } : {}),
      });
      await client.cluster.health({ wait_for_status: 'yellow', timeout: '30s' });
    },

    async close() {
      await client?.close();
      client = null;
    },

    async serverVersion() {
      const info = await db().info();
      return String(info.version?.number ?? 'unknown');
    },

    async memoryConfig() {
      const stats = await db().nodes.stats({ metric: 'jvm' });
      const node = Object.values(stats.nodes ?? {})[0] as
        | { jvm?: { mem?: { heap_max_in_bytes?: number } } }
        | undefined;
      const maxHeap = node?.jvm?.mem?.heap_max_in_bytes;
      return {
        // Read back from the node itself, not just echoed from ES_JAVA_OPTS:
        // the JVM applies its own defaults/ergonomics on top of what was set.
        heapMaxGB: maxHeap ? (maxHeap / 1024 ** 3).toFixed(2) : 'unknown',
      };
    },

    async resetSchema() {
      for (const index of ['users', 'posts', 'likes']) {
        await db().indices.delete({ index, ignore_unavailable: true });
      }
      await db().indices.create({
        index: 'users',
        mappings: {
          properties: {
            id: { type: 'integer' },
            first_name: { type: 'keyword' },
            last_name: { type: 'keyword' },
            email: { type: 'keyword' },
            password: { type: 'keyword' },
            age: { type: 'integer' },
            gender: { type: 'keyword' },
            created_at: { type: 'date' },
            updated_at: { type: 'date' },
          },
        },
      });
      await db().indices.create({
        index: 'posts',
        mappings: {
          properties: {
            id: { type: 'integer' },
            user_id: { type: 'integer' },
            title: { type: 'text' },
            body: { type: 'text' },
            like_count: { type: 'integer' },
            created_at: { type: 'date' },
            updated_at: { type: 'date' },
          },
        },
      });
    },

    async insertUsers(batch: readonly User[]) {
      if (batch.length === 0) return;
      const operations = batch.flatMap((u) => [{ index: { _index: 'users', _id: String(u.id) } }, u]);
      await db().bulk({ operations, refresh: false });
    },

    async insertPosts(batch: readonly Post[]) {
      if (batch.length === 0) return;
      const operations = batch.flatMap((p) => [{ index: { _index: 'posts', _id: String(p.id) } }, p]);
      await db().bulk({ operations, refresh: false });
    },

    async getUserByEmail(email: string) {
      const res = await db().search({ index: 'users', size: 1, query: { term: { email } } });
      return res.hits.hits[0]?._source ?? null;
    },

    async listPosts(limit: number) {
      const res = await db().search({ index: 'posts', size: limit, sort: [{ id: 'asc' }] });
      return res.hits.hits.map((h) => h._source);
    },

    async countUsersByAgeRange(min: number, max: number) {
      const res = await db().count({ index: 'users', query: { range: { age: { gte: min, lte: max } } } });
      return res.count;
    },

    async topPostsByLikes(limit: number) {
      const res = await db().search({ index: 'posts', size: limit, sort: [{ like_count: 'desc' }, { id: 'asc' }] });
      return res.hits.hits.map((h) => h._source);
    },

    async likePost(): Promise<TxOutcome> {
      return unsupported('like-tx');
    },

    async verifyCounters(): Promise<CounterCheck> {
      return unsupported('counter verification (like-tx does not run here)');
    },
  };
}
