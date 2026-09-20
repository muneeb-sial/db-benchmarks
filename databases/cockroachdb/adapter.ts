import process from 'node:process';
import postgres from 'postgres';
import { Runtime, type Adapter, type ConnectOptions } from '../../src/core/adapter.ts';
import { createAdapter as createPgFamilyAdapter } from '../postgres/adapter.ts';

/**
 * CockroachDB reuses the Postgres adapter wholesale: it speaks the Postgres
 * wire protocol and accepts the same schema unchanged.
 *
 * What genuinely differs is transaction behaviour. CockroachDB defaults to
 * SERIALIZABLE and aborts conflicting transactions with SQLSTATE 40001 rather
 * than blocking on a row lock. Under the hot-contention workload that is the
 * expected path, not an edge case -- and `sql.begin()` does not retry on its
 * own, so the shared withRetry wrapper in the Postgres adapter is doing real
 * work here. Retry counts in the results are the number to watch.
 */
export function createAdapter(): Adapter {
  const base = createPgFamilyAdapter({
    engine: 'cockroachdb',
    displayName: 'CockroachDB',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    dialect: 'cockroachdb',
    versionQuery: async (sql) => {
      const [row] = await sql<{ version: string }[]>`select version()`;
      // e.g. "CockroachDB CCL v24.2.3 (x86_64-pc-linux-gnu, built ...)".
      // Drop the build details and the redundant product name, which the
      // reporter already prints as the display name.
      const head = row?.version?.split('(')[0]?.trim() ?? '';
      return head.replace(/^CockroachDB\s+/i, '') || 'unknown';
    },
  });

  return {
    ...base,

    async connect(opts: ConnectOptions) {
      // The Postgres image creates POSTGRES_DB on first boot; CockroachDB has
      // no equivalent, so `start-single-node` comes up with only `defaultdb`.
      // Create the target database over a throwaway connection first.
      const bootstrap = postgres({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: 'defaultdb',
        max: 1,
        onnotice: () => {},
      });
      try {
        await bootstrap.unsafe(`create database if not exists "${opts.database}"`);
      } finally {
        await bootstrap.end();
      }

      await base.connect(opts);
    },

    async memoryConfig() {
      // The real knobs are the --cache and --max-sql-memory start flags, which
      // are not introspectable over SQL, so they are echoed from the
      // environment for the results file rather than queried.
      return {
        cache: process.env.CRDB_CACHE ?? '.25 (fraction of container limit)',
        maxSqlMemory: process.env.CRDB_MAX_SQL_MEMORY ?? '.25 (fraction of container limit)',
        note: 'set via --cache / --max-sql-memory in docker-compose.yml',
      };
    },
  };
}
