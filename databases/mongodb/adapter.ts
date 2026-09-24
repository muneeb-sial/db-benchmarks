import { MongoClient, type Db } from 'mongodb';
import { Runtime } from '../../src/core/adapter.ts';
import { createMongoSuite } from './suite.ts';
import type { Adapter, ConnectOptions } from '../../src/types/adapter.type.ts';

export function createAdapter(): Adapter {
  let client: MongoClient | null = null;
  let db: Db | null = null;

  const database = (): Db => {
    if (!db) throw new Error('mongodb adapter used before connect()');
    return db;
  };

  return {
    engine: 'mongodb',
    displayName: 'MongoDB',
    // Verified on Node and Bun. Deno is unsupported repo-wide.
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    suite: createMongoSuite(database),

    async connect(opts: ConnectOptions) {
      const auth = opts.user ? `${opts.user}:${opts.password}@` : '';
      // directConnection=true is deliberate. With ?replicaSet=rs0 the driver
      // performs topology discovery against whatever hostname the replica set
      // advertises, which for a single-node set in Docker is frequently
      // unreachable from the host and surfaces as a server-selection timeout.
      const uri =
        `mongodb://${auth}${opts.host}:${opts.port}/?directConnection=true` +
        `&maxPoolSize=${opts.poolSize}&serverSelectionTimeoutMS=10000`;

      client = await MongoClient.connect(uri);
      db = client.db(opts.database);
    },

    async close() {
      await client?.close();
      client = null;
      db = null;
    },

    async serverVersion() {
      const info = await database().admin().serverInfo();
      return String(info.version ?? 'unknown');
    },

    async memoryConfig() {
      const status = await database().admin().command({ serverStatus: 1 });
      const cacheBytes = status?.wiredTiger?.cache?.['maximum bytes configured'];
      const hello = await database().admin().command({ hello: 1 });
      return {
        wiredTigerCacheGB: cacheBytes
          ? (Number(cacheBytes) / 1024 ** 3).toFixed(2)
          : 'unknown',
        replicaSet: String(hello.setName ?? 'standalone'),
        // On a single-node set, w:majority is satisfied by one node, so Mongo
        // pays no replication cost here. Published so nobody mistakes this for
        // a durable multi-node result.
        writeConcern: JSON.stringify(database().writeConcern ?? { w: 'default' }),
      };
    },
  };
}
