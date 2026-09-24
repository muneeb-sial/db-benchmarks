import { Client } from '@elastic/elasticsearch';
import { Runtime, type Adapter, type ConnectOptions } from '../../src/core/adapter.ts';
import { createElasticsearchSuite } from './suite.ts';

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
  };
}
