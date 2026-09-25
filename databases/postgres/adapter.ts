import postgres from 'postgres';
import { Runtime } from '../../src/core/adapter.ts';
import { errorCode } from '../../src/core/errors.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlSuite } from '../../src/sql/suite.ts';
import { createSqlImpl } from '../../src/sql/impl.ts';
import { withImpl } from '../../src/suite/with-impl.ts';
import type { Adapter, ConnectOptions } from '../../src/types/adapter.type.ts';
import type { SqlExecutor } from '../../src/types/sql-suite.type.ts';
import type { PgFamilyOptions } from '../../src/types/postgres.type.ts';

/** 23505 unique_violation. */
const UNIQUE_VIOLATION = '23505';

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

  const d = DIALECTS[options.dialect ?? 'postgres'];
  const suite = withImpl(createSqlSuite(d, executor), (o) => createSqlImpl(d, executor, o));

  return {
    engine: options.engine ?? 'postgres',
    displayName: options.displayName ?? 'PostgreSQL',
    // postgres.js is the one driver with first-class support on all three.
    supportedRuntimes: options.supportedRuntimes ?? [Runtime.Node, Runtime.Bun],
    suite: suite,

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
