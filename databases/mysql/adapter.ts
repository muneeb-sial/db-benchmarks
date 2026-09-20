import mysql from 'mysql2/promise';
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

const ER_DUP_ENTRY = 1062;
/**
 * 1213 ER_LOCK_DEADLOCK  - InnoDB detected a cycle and killed this transaction.
 * 1205 ER_LOCK_WAIT_TIMEOUT - waited past innodb_lock_wait_timeout (default 50s).
 *
 * Both are routine under the hot-contention workload, not exceptional. At
 * MySQL's default REPEATABLE READ the insert into `likes` takes gap/next-key
 * locks, which is a classic deadlock source for exactly this insert+update
 * shape -- which is why the compose file pins READ-COMMITTED to match Postgres.
 */
const RETRYABLE_ERRNO = new Set([1213, 1205]);

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

  const isRetryable = (err: unknown): boolean => {
    const code = errno(err);
    return code !== undefined && RETRYABLE_ERRNO.has(code);
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
    capabilities: {
      transactionality: Transactionality.Acid,
      // Default collations are _ci, so LIKE is case-insensitive for free.
      caseInsensitiveLike: true,
      unsupportedWorkloads: [],
    },
    isRetryable,
    suite: createSqlSuite(DIALECTS.mysql, executor),

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

    async resetSchema() {
      await db().query('drop table if exists likes');
      await db().query('drop table if exists posts');
      await db().query('drop table if exists users');

      await db().query(`
        create table users (
          id          int primary key,
          first_name  varchar(255) not null,
          last_name   varchar(255) not null,
          email       varchar(255) not null,
          password    varchar(255) not null,
          age         int          not null,
          gender      varchar(255) not null,
          created_at  datetime(3)  not null,
          updated_at  datetime(3)  not null,
          unique key users_email_uq (email)
        ) engine=InnoDB`);

      await db().query(`
        create table posts (
          id          int primary key,
          user_id     int         not null,
          title       text        not null,
          body        text        not null,
          like_count  int         not null default 0,
          created_at  datetime(3) not null,
          updated_at  datetime(3) not null,
          key posts_user_id_idx (user_id),
          key posts_like_count_idx (like_count desc),
          constraint posts_user_fk foreign key (user_id) references users(id)
        ) engine=InnoDB`);

      await db().query(`
        create table likes (
          user_id    int         not null,
          post_id    int         not null,
          created_at datetime(3) not null,
          primary key (user_id, post_id),
          key likes_post_idx (post_id),
          constraint likes_user_fk foreign key (user_id) references users(id),
          constraint likes_post_fk foreign key (post_id) references posts(id)
        ) engine=InnoDB`);
    },

    async insertUsers(batch: readonly User[]) {
      const rows = batch.map((u) => [
        u.id, u.first_name, u.last_name, u.email, u.password,
        u.age, u.gender, u.created_at, u.updated_at,
      ]);
      await db().query(
        `insert into users (id, first_name, last_name, email, password, age, gender, created_at, updated_at)
         values ?`,
        [rows],
      );
    },

    async insertPosts(batch: readonly Post[]) {
      const rows = batch.map((p) => [
        p.id, p.user_id, p.title, p.body, p.like_count, p.created_at, p.updated_at,
      ]);
      await db().query(
        `insert into posts (id, user_id, title, body, like_count, created_at, updated_at)
         values ?`,
        [rows],
      );
    },

    async getUserByEmail(email: string) {
      const [rows] = await db().execute<mysql.RowDataPacket[]>(
        'select * from users where email = ?',
        [email],
      );
      return rows[0] ?? null;
    },

    async listPosts(limit: number) {
      const [rows] = await db().query<mysql.RowDataPacket[]>(
        'select * from posts order by id limit ?',
        [limit],
      );
      return rows;
    },

    async countUsersByAgeRange(min: number, max: number) {
      const [rows] = await db().execute<mysql.RowDataPacket[]>(
        'select count(*) as total from users where age between ? and ?',
        [min, max],
      );
      return Number(rows[0]?.total ?? 0);
    },

    async topPostsByLikes(limit: number) {
      const [rows] = await db().query<mysql.RowDataPacket[]>(
        'select id, like_count from posts order by like_count desc, id limit ?',
        [limit],
      );
      return rows;
    },

    async likePost(userId: number, postId: number): Promise<TxOutcome> {
      try {
        const { retries } = await withRetry(async () => {
          const conn = await db().getConnection();
          try {
            await conn.beginTransaction();
            // posts before likes -- the same lock order every adapter uses.
            await conn.execute(
              'update posts set like_count = like_count + 1 where id = ?',
              [postId],
            );
            await conn.execute(
              'insert into likes (user_id, post_id, created_at) values (?, ?, now(3))',
              [userId, postId],
            );
            await conn.commit();
          } catch (err) {
            await conn.rollback().catch(() => {});
            throw err;
          } finally {
            conn.release();
          }
        }, { isRetryable });
        return { retries, conflict: false };
      } catch (err) {
        if (errno(err) === ER_DUP_ENTRY) return { retries: 0, conflict: true };
        throw err;
      }
    },

    async verifyCounters(): Promise<CounterCheck> {
      const [rows] = await db().query<mysql.RowDataPacket[]>(`
        select
          sum(case when p.like_count <> coalesce(l.c, 0) then 1 else 0 end) as mismatches,
          count(*)                                                          as checked,
          max(abs(p.like_count - coalesce(l.c, 0)))                         as drift
        from posts p
        left join (select post_id, count(*) as c from likes group by post_id) l
          on l.post_id = p.id
      `);
      const row = rows[0];
      return {
        mismatches: Number(row?.mismatches ?? 0),
        postsChecked: Number(row?.checked ?? 0),
        worstDrift: Number(row?.drift ?? 0),
      };
    },
  };
}
