import sql from 'mssql';
import { Runtime } from '../../src/core/adapter.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlImpl } from '../../src/sql/impl.ts';
import { createSqlSuite } from '../../src/sql/suite.ts';
import { withImpl } from '../../src/suite/with-impl.ts';
import type { Adapter, ConnectOptions } from '../../src/types/adapter.type.ts';
import type { SqlExecutor } from '../../src/types/sql-suite.type.ts';

/** 2627 unique/primary key constraint violation, 2601 duplicate key in a unique index. */
const DUPLICATE_KEYS = new Set([2627, 2601]);

/** mssql wraps tedious errors; the SQL Server error number lives in different places. */
function sqlNumber(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as {
    number?: unknown;
    originalError?: { number?: unknown; info?: { number?: unknown } };
  };
  for (const n of [e.number, e.originalError?.number, e.originalError?.info?.number]) {
    if (typeof n === 'number') return n;
  }
  return undefined;
}

export function createAdapter(): Adapter {
  let pool: sql.ConnectionPool | null = null;

  const db = (): sql.ConnectionPool => {
    if (!pool) throw new Error('mssql adapter used before connect()');
    return pool;
  };

  const config = (opts: ConnectOptions, database: string): sql.config => ({
    server: opts.host,
    port: opts.port,
    user: opts.user,
    password: opts.password,
    database,
    pool: { max: opts.poolSize, min: 0 },
    options: {
      // Local benchmark fixture: the container uses a self-signed certificate.
      encrypt: false,
      trustServerCertificate: true,
    },
    requestTimeout: 60_000,
  });

  /** Binds positional params as @p1..@pn, typed so string params never force index-hostile conversions. */
  const bind = (req: sql.Request, params: unknown[]): sql.Request => {
    params.forEach((v, i) => {
      const name = `p${i + 1}`;
      if (v instanceof Date) {
        req.input(name, sql.DateTime2(3), v);
      } else if (typeof v === 'number') {
        req.input(name, Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? sql.Int : sql.BigInt, v);
      } else {
        req.input(name, sql.VarChar(255), v as string);
      }
    });
    return req;
  };

  const literal = (v: unknown): string => {
    if (v instanceof Date) return `'${v.toISOString().slice(0, -1)}'`;
    if (typeof v === 'number') return String(v);
    return `'${String(v).replace(/'/g, "''")}'`;
  };

  const columnType = (type: string) => {
    switch (type) {
      case 'int':
        return sql.Int;
      case 'timestamp':
        return sql.DateTime2(3);
      case 'text':
        return sql.VarChar(sql.MAX);
      case 'json':
        return sql.NVarChar(sql.MAX);
      default:
        return sql.VarChar(255);
    }
  };

  const executor: SqlExecutor = {
    async query(text, params) {
      const r = await bind(db().request(), params).query(text);
      return toRunOut((r.recordset ?? []) as unknown as ArrayLike<unknown>);
    },
    async execute(text) {
      await db().request().batch(text);
    },
    async write(text, params) {
      await bind(db().request(), params).query(text);
    },
    async explain(text, params) {
      // SHOWPLAN is per-connection state, so run it on one pinned connection
      // (a transaction) and inline the parameters: under SHOWPLAN the statement
      // is not executed, and sp_executesql would hide the real plan.
      let inlined = text;
      for (let i = params.length; i >= 1; i--) {
        inlined = inlined.split(`@p${i}`).join(literal(params[i - 1]));
      }
      const tx = new sql.Transaction(db());
      await tx.begin();
      try {
        await new sql.Request(tx).batch('set showplan_text on');
        const r = await new sql.Request(tx).batch(inlined);
        await new sql.Request(tx).batch('set showplan_text off');
        const rows = (r.recordset ?? []) as unknown as Array<Record<string, unknown>>;
        return rows.map((row) => String(Object.values(row)[0])).join('\n');
      } finally {
        await tx.rollback().catch(() => {});
      }
    },
    async bulkInsert(table, cols, rows) {
      const t = new sql.Table(table);
      t.create = false;
      for (const c of cols) t.columns.add(c.name, columnType(c.type), { nullable: false });
      for (const row of rows) {
        t.rows.add(...(row.map((v, i) => (cols[i]?.type === 'json' ? JSON.stringify(v) : v)) as never[]));
      }
      await db().request().bulk(t);
    },
    isUniqueViolation: (err) => {
      const n = sqlNumber(err);
      return n !== undefined && DUPLICATE_KEYS.has(n);
    },
    async scalar(text) {
      const r = await db().request().query(text);
      const first = (r.recordset?.[0] ?? null) as Record<string, unknown> | null;
      const v = first ? Object.values(first)[0] : null;
      return v === null || v === undefined ? null : Number(v);
    },
  };

  return {
    engine: 'mssql',
    displayName: 'SQL Server',
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    suite: withImpl(createSqlSuite(DIALECTS.mssql, executor), (o) => createSqlImpl(DIALECTS.mssql, executor, o)),

    async connect(opts: ConnectOptions) {
      // The container starts with only the system databases. Create ours, and
      // turn on READ_COMMITTED_SNAPSHOT: SQL Server's default READ COMMITTED
      // takes shared locks so readers block writers, whereas Postgres and MySQL
      // use row versioning. Without RCSI the comparison is structurally unfair
      // to SQL Server. It needs exclusive access, hence the bootstrap pool.
      const bootstrap = await new sql.ConnectionPool(config(opts, 'master')).connect();
      try {
        const ident = opts.database.replace(/]/g, ']]');
        const literal = opts.database.replace(/'/g, "''");
        await bootstrap.request().query(`
          if db_id(N'${literal}') is null create database [${ident}];
          alter database [${ident}] set read_committed_snapshot on with rollback immediate;
        `);
      } finally {
        await bootstrap.close();
      }

      pool = await new sql.ConnectionPool(config(opts, opts.database)).connect();
    },

    async close() {
      await pool?.close();
      pool = null;
    },

    async serverVersion() {
      const r = await db()
        .request()
        .query<{ v: string; e: string }>(
          `select cast(serverproperty('ProductVersion') as varchar(50)) as v,
                  cast(serverproperty('Edition') as varchar(100)) as e`,
        );
      const row = r.recordset[0];
      return row ? `${row.v} (${row.e})` : 'unknown';
    },

    async memoryConfig() {
      const r = await db()
        .request()
        .query<{ name: string; value_in_use: number }>(
          `select name, cast(value_in_use as bigint) as value_in_use from sys.configurations
           where name in ('max server memory (MB)', 'max degree of parallelism')`,
        );
      const rcsi = await db()
        .request()
        .query<{ is_read_committed_snapshot_on: boolean }>(
          'select is_read_committed_snapshot_on from sys.databases where name = db_name()',
        );
      return {
        ...Object.fromEntries(r.recordset.map((x) => [x.name, String(x.value_in_use)])),
        read_committed_snapshot: String(rcsi.recordset[0]?.is_read_committed_snapshot_on ?? false),
      };
    },
  };
}
