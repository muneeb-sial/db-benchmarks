import postgres from 'postgres';
import { Runtime, type Adapter, type ConnectOptions } from '../../src/core/adapter.ts';
import { errorCode } from '../../src/core/errors.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlSuite, type SqlExecutor } from '../../src/sql/suite.ts';

/** 23505 unique_violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * CockroachDB speaks the Postgres wire protocol and accepts this schema
 * unchanged, so it reuses this adapter rather than duplicating it. Only the
 * identity and the server-introspection queries differ.
 */
export interface PgFamilyOptions {
  engine?: string;
  displayName?: string;
  supportedRuntimes?: readonly Runtime[];
  /**
   * How to read the server version. CockroachDB's `server_version` reports the
   * Postgres compatibility level it advertises (13.0.0), not its own version,
   * so it substitutes `select version()`.
   */
  versionQuery?: (sql: postgres.Sql) => Promise<string>;
  /** Which SQL dialect the suite renders for. */
  dialect?: 'postgres' | 'cockroachdb';
}

export function createAdapter(options: PgFamilyOptions = {}): Adapter {
  let sql: postgres.Sql | null = null;

  const db = (): postgres.Sql => {
    if (!sql) throw new Error('postgres adapter used before connect()');
    return sql;
  };

  // How the shared SQL suite talks to this driver. `unsafe` is the only way to
  // run generated SQL with positional parameters in postgres.js.
  const executor: SqlExecutor = {
    async query(text, params) {
      const rows = await db().unsafe(text, params as never[]);
      return toRunOut(rows as unknown as ArrayLike<unknown>);
    },
    async execute(text) {
      await db().unsafe(text);
    },
    async write(text, params) {
      await db().unsafe(text, params as never[]);
    },
    async explain(text, params) {
      const rows = await db().unsafe(`explain ${text}`, params as never[]);
      return (rows as unknown as Array<Record<string, unknown>>)
        .map((r) => String(Object.values(r)[0]))
        .join('\n');
    },
    async bulkInsert(table, cols, rows) {
      // Multi-row VALUES, capped well under the 65,535 parameter limit.
      const perStatement = Math.max(1, Math.floor(30000 / cols.length));
      const names = cols.map((c) => c.name).join(', ');
      for (let i = 0; i < rows.length; i += perStatement) {
        const slice = rows.slice(i, i + perStatement);
        let n = 0;
        const values = slice
          .map(
            () =>
              '(' + cols.map((c) => `$${++n}${c.type === 'json' ? '::jsonb' : ''}`).join(', ') + ')',
          )
          .join(', ');
        await db().unsafe(
          `insert into ${table} (${names}) values ${values}`,
          slice.flat() as never[],
        );
      }
    },
    isUniqueViolation: (err) => errorCode(err) === UNIQUE_VIOLATION,
    async scalar(text) {
      const rows = (await db().unsafe(text)) as unknown as Array<Record<string, unknown>>;
      const first = rows[0];
      const v = first ? Object.values(first)[0] : null;
      return v === null || v === undefined ? null : Number(v);
    },
  };

  return {
    engine: options.engine ?? 'postgres',
    displayName: options.displayName ?? 'PostgreSQL',
    // postgres.js is the one driver with first-class support on all three.
    supportedRuntimes: options.supportedRuntimes ?? [Runtime.Node, Runtime.Bun],
    suite: createSqlSuite(DIALECTS[options.dialect ?? 'postgres'], executor),

    async connect(opts: ConnectOptions) {
      sql = postgres({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: opts.database,
        max: opts.poolSize,
        onnotice: () => {},
      });
      await sql`select 1`;
    },

    async close() {
      await sql?.end();
      sql = null;
    },

    async serverVersion() {
      if (options.versionQuery) return options.versionQuery(db());
      // The column is named after the setting, i.e. `server_version`.
      const [row] = await db()<{ server_version: string }[]>`show server_version`;
      return row?.server_version ?? 'unknown';
    },

    async memoryConfig() {
      const rows = await db()<{ name: string; setting: string; unit: string | null }[]>`
        select name, setting, unit from pg_settings
        where name in ('shared_buffers', 'effective_cache_size', 'work_mem', 'max_connections')
      `;
      return Object.fromEntries(
        rows.map((r) => [r.name, r.unit ? `${r.setting}${r.unit}` : r.setting]),
      );
    },

  };
}
