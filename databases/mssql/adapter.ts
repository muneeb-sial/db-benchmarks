import sql from 'mssql';
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
import { withRetry } from '../../src/core/retry.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlSuite, type SqlExecutor } from '../../src/sql/suite.ts';

/**
 * 2627 unique/primary key constraint violation, 2601 duplicate key in a unique
 * index. 1205 deadlock victim (the engine killed this transaction; retry it).
 */
const DUPLICATE_KEYS = new Set([2627, 2601]);
const RETRYABLE = new Set([1205]);

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

  const isRetryable = (err: unknown): boolean => {
    const n = sqlNumber(err);
    return n !== undefined && RETRYABLE.has(n);
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
    capabilities: {
      transactionality: Transactionality.Acid,
      caseInsensitiveLike: true, // default collation is case-insensitive
      unsupportedWorkloads: [],
    },
    isRetryable,
    suite: createSqlSuite(DIALECTS.mssql, executor),

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

    async resetSchema() {
      const q = (text: string) => db().request().query(text);
      await q("if object_id('likes', 'U') is not null drop table likes");
      await q("if object_id('posts', 'U') is not null drop table posts");
      await q("if object_id('users', 'U') is not null drop table users");

      await q(`
        create table users (
          id          int          not null primary key,
          first_name  varchar(255) not null,
          last_name   varchar(255) not null,
          email       varchar(255) not null,
          password    varchar(255) not null,
          age         int          not null,
          gender      varchar(255) not null,
          created_at  datetime2(3) not null,
          updated_at  datetime2(3) not null,
          constraint users_email_uq unique (email)
        )`);

      await q(`
        create table posts (
          id          int           not null primary key,
          user_id     int           not null references users(id),
          title       nvarchar(max) not null,
          body        nvarchar(max) not null,
          like_count  int           not null default 0,
          created_at  datetime2(3)  not null,
          updated_at  datetime2(3)  not null
        )`);
      await q('create index posts_user_id_idx on posts (user_id)');
      await q('create index posts_like_count_idx on posts (like_count desc)');

      await q(`
        create table likes (
          user_id    int          not null references users(id),
          post_id    int          not null references posts(id),
          created_at datetime2(3) not null,
          primary key (user_id, post_id)
        )`);
      await q('create index likes_post_idx on likes (post_id)');
    },

    async insertUsers(batch: readonly User[]) {
      const t = new sql.Table('users');
      t.create = false;
      t.columns.add('id', sql.Int, { nullable: false });
      t.columns.add('first_name', sql.VarChar(255), { nullable: false });
      t.columns.add('last_name', sql.VarChar(255), { nullable: false });
      t.columns.add('email', sql.VarChar(255), { nullable: false });
      t.columns.add('password', sql.VarChar(255), { nullable: false });
      t.columns.add('age', sql.Int, { nullable: false });
      t.columns.add('gender', sql.VarChar(255), { nullable: false });
      t.columns.add('created_at', sql.DateTime2(3), { nullable: false });
      t.columns.add('updated_at', sql.DateTime2(3), { nullable: false });
      for (const u of batch) {
        t.rows.add(
          u.id, u.first_name, u.last_name, u.email, u.password,
          u.age, u.gender, u.created_at, u.updated_at,
        );
      }
      await db().request().bulk(t);
    },

    async insertPosts(batch: readonly Post[]) {
      const t = new sql.Table('posts');
      t.create = false;
      t.columns.add('id', sql.Int, { nullable: false });
      t.columns.add('user_id', sql.Int, { nullable: false });
      t.columns.add('title', sql.NVarChar(sql.MAX), { nullable: false });
      t.columns.add('body', sql.NVarChar(sql.MAX), { nullable: false });
      t.columns.add('like_count', sql.Int, { nullable: false });
      t.columns.add('created_at', sql.DateTime2(3), { nullable: false });
      t.columns.add('updated_at', sql.DateTime2(3), { nullable: false });
      for (const p of batch) {
        t.rows.add(p.id, p.user_id, p.title, p.body, p.like_count, p.created_at, p.updated_at);
      }
      await db().request().bulk(t);
    },

    async getUserByEmail(email: string) {
      const r = await db()
        .request()
        .input('email', sql.VarChar(255), email)
        .query('select * from users where email = @email');
      return r.recordset[0] ?? null;
    },

    async listPosts(limit: number) {
      const r = await db()
        .request()
        .input('n', sql.Int, limit)
        .query('select top (@n) * from posts order by id');
      return r.recordset;
    },

    async countUsersByAgeRange(min: number, max: number) {
      const r = await db()
        .request()
        .input('min', sql.Int, min)
        .input('max', sql.Int, max)
        .query<{ total: number }>(
          'select count(*) as total from users where age between @min and @max',
        );
      return Number(r.recordset[0]?.total ?? 0);
    },

    async topPostsByLikes(limit: number) {
      const r = await db()
        .request()
        .input('n', sql.Int, limit)
        .query('select top (@n) id, like_count from posts order by like_count desc, id');
      return r.recordset;
    },

    async likePost(userId: number, postId: number): Promise<TxOutcome> {
      try {
        const { retries } = await withRetry(
          async () => {
            const tx = new sql.Transaction(db());
            await tx.begin();
            try {
              // posts before likes: the same lock order every adapter uses.
              await new sql.Request(tx)
                .input('p', sql.Int, postId)
                .query('update posts set like_count = like_count + 1 where id = @p');
              await new sql.Request(tx)
                .input('u', sql.Int, userId)
                .input('p', sql.Int, postId)
                .query(
                  'insert into likes (user_id, post_id, created_at) values (@u, @p, sysutcdatetime())',
                );
              await tx.commit();
            } catch (err) {
              await tx.rollback().catch(() => {});
              throw err;
            }
          },
          { isRetryable },
        );
        return { retries, conflict: false };
      } catch (err) {
        const n = sqlNumber(err);
        if (n !== undefined && DUPLICATE_KEYS.has(n)) return { retries: 0, conflict: true };
        throw err;
      }
    },

    async verifyCounters(): Promise<CounterCheck> {
      const r = await db()
        .request()
        .query<{ mismatches: number; checked: number; drift: number | null }>(`
          select
            sum(case when p.like_count <> coalesce(l.c, 0) then 1 else 0 end) as mismatches,
            count(*)                                                          as checked,
            max(abs(p.like_count - coalesce(l.c, 0)))                         as drift
          from posts p
          left join (select post_id, count(*) as c from likes group by post_id) l
            on l.post_id = p.id`);
      const row = r.recordset[0];
      return {
        mismatches: Number(row?.mismatches ?? 0),
        postsChecked: Number(row?.checked ?? 0),
        worstDrift: Number(row?.drift ?? 0),
      };
    },
  };
}
