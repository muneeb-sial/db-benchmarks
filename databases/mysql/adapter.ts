import mysql from 'mysql2/promise';
import { Runtime } from '../../src/core/adapter.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlImpl } from '../../src/sql/impl.ts';
import { createSqlSuite } from '../../src/sql/suite.ts';
import { withImpl } from '../../src/suite/with-impl.ts';
import type { Adapter, ConnectOptions } from '../../src/types/adapter.type.ts';
import type { SqlExecutor } from '../../src/types/sql-suite.type.ts';

const ER_DUP_ENTRY = 1062;

function errno(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { errno?: unknown };
  return typeof e.errno === 'number' ? e.errno : undefined;
}

export function createAdapter(): Adapter {
  let pool: mysql.Pool | null = null;

  const db = (): mysql.Pool => {
    if (!pool) throw new Error('mysql adapter used before connect()');
    return pool;
  };

  // mysql2 binds JSON as text, so JSON columns are stringified on the way in.
  const encode = (cols: { type: string }[], row: unknown[]): unknown[] =>
    row.map((v, i) => (cols[i]?.type === 'json' ? JSON.stringify(v) : v));

  const executor: SqlExecutor = {
    async query(text, params) {
      const [rows] = await db().query(text, params);
      return Array.isArray(rows) ? toRunOut(rows) : { rows: 0, lastKey: null };
    },
    async execute(text) {
      await db().query(text);
    },
    async write(text, params) {
      await db().query(text, params);
    },
    async explain(text, params) {
      const [rows] = await db().query(`explain ${text}`, params);
      return JSON.stringify(rows);
    },
    async bulkInsert(table, cols, rows) {
      const names = cols.map((c) => c.name).join(', ');
      // Kept under max_allowed_packet (64MB by default) even for wide rows.
      const perStatement = 10_000;
      for (let i = 0; i < rows.length; i += perStatement) {
        const slice = rows.slice(i, i + perStatement).map((r) => encode(cols, r));
        await db().query(`insert into ${table} (${names}) values ?`, [slice]);
      }
    },
    isUniqueViolation: (err) => errno(err) === ER_DUP_ENTRY,
    async scalar(text) {
      const [rows] = await db().query(text);
      const first = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
      const v = first ? Object.values(first)[0] : null;
      return v === null || v === undefined ? null : Number(v);
    },
  };

  return {
    engine: 'mysql',
    displayName: 'MySQL',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    suite: withImpl(createSqlSuite(DIALECTS.mysql, executor), (o) => createSqlImpl(DIALECTS.mysql, executor, o)),

    async connect(opts: ConnectOptions) {
      pool = mysql.createPool({
        host: opts.host,
        port: opts.port,
        user: opts.user,
        password: opts.password,
        database: opts.database,
        connectionLimit: opts.poolSize,
        waitForConnections: true,
        // Keep BIGINT/DECIMAL as numbers so COUNT(*) does not arrive as a
        // string and quietly break arithmetic.
        decimalNumbers: true,
      });
      await pool.query('select 1');
    },

    async close() {
      await pool?.end();
      pool = null;
    },

    async serverVersion() {
      const [rows] = await db().query<mysql.RowDataPacket[]>('select version() as v');
      return String(rows[0]?.v ?? 'unknown');
    },

    async memoryConfig() {
      const [rows] = await db().query<mysql.RowDataPacket[]>(
        `show variables where variable_name in
         ('innodb_buffer_pool_size','innodb_log_file_size','transaction_isolation','max_connections')`,
      );
      return Object.fromEntries(rows.map((r) => [String(r.Variable_name), String(r.Value)]));
    },
  };
}
