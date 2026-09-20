import postgres from 'postgres';
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
import { errorCode, withRetry } from '../../src/core/retry.ts';
import { DIALECTS } from '../../src/sql/dialect.ts';
import { toRunOut } from '../../src/sql/queries.ts';
import { createSqlSuite, type SqlExecutor } from '../../src/sql/suite.ts';

/** 23505 unique_violation, 40001 serialization_failure, 40P01 deadlock_detected. */
const UNIQUE_VIOLATION = '23505';
const RETRYABLE = new Set(['40001', '40P01']);

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

  const isRetryable = (err: unknown): boolean => {
    const code = errorCode(err);
    return code !== undefined && RETRYABLE.has(code);
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
    capabilities: {
      transactionality: Transactionality.Acid,
      caseInsensitiveLike: false, // needs ILIKE
      unsupportedWorkloads: [],
    },
    isRetryable,
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

    async resetSchema() {
      await db()`drop table if exists likes`;
      await db()`drop table if exists posts`;
      await db()`drop table if exists users`;

      await db()`
        create table users (
          id          int primary key,
          first_name  varchar(255) not null,
          last_name   varchar(255) not null,
          email       varchar(255) not null unique,
          password    varchar(255) not null,
          age         int          not null,
          gender      varchar(255) not null,
          created_at  timestamptz  not null,
          updated_at  timestamptz  not null
        )`;

      await db()`
        create table posts (
          id          int primary key,
          user_id     int         not null references users(id),
          title       text        not null,
          body        text        not null,
          like_count  int         not null default 0,
          created_at  timestamptz not null,
          updated_at  timestamptz not null
        )`;

      await db()`
        create table likes (
          user_id    int         not null references users(id),
          post_id    int         not null references posts(id),
          created_at timestamptz not null,
          primary key (user_id, post_id)
        )`;

      await db()`create index posts_user_id_idx on posts (user_id)`;
      await db()`create index posts_like_count_idx on posts (like_count desc)`;
    },

    async insertUsers(batch: readonly User[]) {
      await db()`insert into users ${db()(batch as User[])}`;
    },

    async insertPosts(batch: readonly Post[]) {
      await db()`insert into posts ${db()(batch as Post[])}`;
    },

    async getUserByEmail(email: string) {
      const [user] = await db()`select * from users where email = ${email}`;
      return user ?? null;
    },

    async listPosts(limit: number) {
      return db()`select * from posts order by id limit ${limit}`;
    },

    async countUsersByAgeRange(min: number, max: number) {
      const [row] = await db()<{ total: string }[]>`
        select count(*) as total from users where age between ${min} and ${max}`;
      return Number(row?.total ?? 0);
    },

    async topPostsByLikes(limit: number) {
      return db()`select id, like_count from posts order by like_count desc, id limit ${limit}`;
    },

    async likePost(userId: number, postId: number): Promise<TxOutcome> {
      try {
        const { retries } = await withRetry(
          () =>
            db().begin(async (tx) => {
              // Fixed global lock order across every engine in this repo:
              // posts first, then likes. Varying the order between adapters
              // would make deadlock rates a property of the adapter rather
              // than of the database.
              await tx`update posts set like_count = like_count + 1 where id = ${postId}`;
              await tx`insert into likes (user_id, post_id, created_at)
                       values (${userId}, ${postId}, now())`;
            }),
          { isRetryable },
        );
        return { retries, conflict: false };
      } catch (err) {
        // The pair already existed. The rollback also undoes the increment,
        // which is precisely the property verifyCounters() is testing.
        if (errorCode(err) === UNIQUE_VIOLATION) return { retries: 0, conflict: true };
        throw err;
      }
    },

    async verifyCounters(): Promise<CounterCheck> {
      const [row] = await db()<{ mismatches: string; checked: string; drift: string | null }[]>`
        select
          count(*) filter (where p.like_count <> coalesce(l.c, 0)) as mismatches,
          count(*)                                                 as checked,
          max(abs(p.like_count - coalesce(l.c, 0)))                as drift
        from posts p
        left join (select post_id, count(*)::int as c from likes group by post_id) l
          on l.post_id = p.id
      `;
      return {
        mismatches: Number(row?.mismatches ?? 0),
        postsChecked: Number(row?.checked ?? 0),
        worstDrift: Number(row?.drift ?? 0),
      };
    },
  };
}
