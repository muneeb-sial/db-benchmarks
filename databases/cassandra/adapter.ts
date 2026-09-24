import process from 'node:process';
import cassandra from 'cassandra-driver';
import { Runtime, type Adapter, type ConnectOptions } from '../../src/core/adapter.ts';
import { createCassandraSuite } from './suite.ts';

const DATACENTER = 'datacenter1';

export function createAdapter(): Adapter {
  let client: cassandra.Client | null = null;

  const db = (): cassandra.Client => {
    if (!client) throw new Error('cassandra adapter used before connect()');
    return client;
  };

  const newClient = (opts: ConnectOptions, keyspace?: string): cassandra.Client =>
    new cassandra.Client({
      contactPoints: [`${opts.host}:${opts.port}`],
      localDataCenter: DATACENTER,
      // Full-table counts and ALLOW FILTERING scans outlast the 12s default.
      socketOptions: { readTimeout: 120_000 },
      ...(keyspace ? { keyspace } : {}),
      ...(opts.user ? { credentials: { username: opts.user, password: opts.password } } : {}),
    });

  return {
    engine: 'cassandra',
    displayName: 'Cassandra',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    suite: createCassandraSuite(db),

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
  };
}
