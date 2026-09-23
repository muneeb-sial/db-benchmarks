/**
 * Maps an engine name to its adapter. Each database owns its folder, so adding
 * one means adding a directory and a line here.
 */

import type { Adapter, ConnectOptions } from './adapter.ts';

export interface EngineDescriptor {
  /** Default connection settings, matching that engine's docker-compose.yml. */
  defaults: ConnectOptions;
  load: () => Promise<Adapter>;
}

export const ENGINES: Record<string, EngineDescriptor> = {
  postgres: {
    defaults: {
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      password: 'postgres',
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/postgres/adapter.ts')).createAdapter(),
  },
  mysql: {
    defaults: {
      host: '127.0.0.1',
      port: 3306,
      user: 'benchmark',
      password: 'benchmark',
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/mysql/adapter.ts')).createAdapter(),
  },
  mongodb: {
    defaults: {
      host: '127.0.0.1',
      port: 27017,
      user: '',
      password: '',
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/mongodb/adapter.ts')).createAdapter(),
  },
  cockroachdb: {
    defaults: {
      host: '127.0.0.1',
      // Deliberately not 5432, so Postgres and CockroachDB can run side by side.
      port: 26257,
      user: 'root',
      password: '',
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/cockroachdb/adapter.ts')).createAdapter(),
  },
  mssql: {
    defaults: {
      host: '127.0.0.1',
      port: 1433,
      user: 'sa',
      password: 'Benchmark_Pass1',
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/mssql/adapter.ts')).createAdapter(),
  },
  cassandra: {
    defaults: {
      host: '127.0.0.1',
      port: 9042,
      // Cassandra ships with authentication off; empty means no credentials.
      user: '',
      password: '',
      // Used as the keyspace name.
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/cassandra/adapter.ts')).createAdapter(),
  },
  elasticsearch: {
    defaults: {
      host: '127.0.0.1',
      port: 9200,
      // Security is disabled in the compose file for local benchmarking.
      user: '',
      password: '',
      // Unused: Elasticsearch has no per-connection database, only index
      // names (optionally prefixed). Kept for interface parity, same as
      // Cassandra reusing this field for its keyspace.
      database: 'benchmark',
      poolSize: 64,
    },
    load: async () => (await import('../../databases/elasticsearch/adapter.ts')).createAdapter(),
  },
};

export const ENGINE_NAMES = Object.keys(ENGINES);
