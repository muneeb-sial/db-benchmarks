/**
 * SQL Server 2022. T-SQL written out per shape and mode: TOP for limit and
 * cursor pages, OFFSET .. FETCH for offset pages, the bulk API for loads and
 * W3, OPENJSON to pass a multi-get key list as one parameter (a plain IN list
 * would hit the 2,100-parameter limit at 1k keys).
 *
 * N/A: the JSON document type (2022 has none) and full-text (the container
 * image ships without the component).
 *
 * The database is created with READ_COMMITTED_SNAPSHOT ON, so readers do not
 * block writers -- the same row-versioning behaviour Postgres and MySQL have.
 */

import sql from 'mssql';
import { CONNECTIONS, POOL_SIZE } from '../config/config.ts';
import { Engine, type LikeCheck, type LikeOutcome, type R7Args } from '../engine/engine.ts';
import type {
  CellParams,
  IndexKind,
  JsonVariant,
  LikePattern,
  OpId,
  OpResult,
  R7Variant,
  ReadQuery,
  Row,
  ScratchTable,
  SeedTable,
  Shape,
  SortKey,
} from '../engine/types.ts';
import { UniqueViolation } from '../http/errors.ts';

/** 2627 PK/unique constraint, 2601 duplicate key in a unique index. */
const DUPLICATE = new Set([2627, 2601]);
/** 1205 deadlock victim. */
const DEADLOCK = 1205;
const MAX_RETRIES = 10;

const NO_JSON = 'SQL Server 2022 has no native JSON document type';
const NO_FULLTEXT = 'the SQL Server container image ships without the full-text component';

function sqlNumber(err: unknown): number | undefined {
  const e = err as { number?: unknown; originalError?: { number?: unknown; info?: { number?: unknown } } };
  for (const n of [e?.number, e?.originalError?.number, e?.originalError?.info?.number]) {
    if (typeof n === 'number') return n;
  }
  return undefined;
}

type Rows = Record<string, unknown>[];

function page(rows: Rows, key: string): OpResult {
  const last = rows.length ? Number(rows[rows.length - 1]![key]) : null;
  return { rows: rows.length, last };
}

export class MsSqlEngine extends Engine {
  readonly name = 'mssql';
  readonly displayName = 'SQL Server';
  private pool: sql.ConnectionPool | null = null;

  private get db(): sql.ConnectionPool {
    if (!this.pool) throw new Error('mssql used before connect()');
    return this.pool;
  }

  /** Runs `text` with named, typed inputs (@lim, @off, @email, ...). */
  private async q(text: string, inputs: Record<string, unknown> = {}): Promise<Rows> {
    const req = this.db.request();
    for (const [name, v] of Object.entries(inputs)) {
      if (v instanceof Date) req.input(name, sql.DateTime2(3), v);
      else if (typeof v === 'number') req.input(name, sql.Int, v);
      else req.input(name, sql.VarChar(sql.MAX), v as string);
    }
    const r = await req.query(text);
    return (r.recordset ?? []) as unknown as Rows;
  }

  support(op: OpId, p: CellParams): string | null {
    if (op === 'w4' || op === 'r10') return NO_JSON;
    if (op === 'r9-fulltext') return NO_FULLTEXT;
    if (op === 'index') {
      if (p.kind === 'fulltext') return NO_FULLTEXT;
      if (p.kind?.startsWith('json')) return NO_JSON;
    }
    return null;
  }

  // ------------------------------------------------------------ lifecycle --

  private config(database: string): sql.config {
    const c = CONNECTIONS.mssql;
    return {
      server: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database,
      pool: { max: POOL_SIZE, min: 0 },
      // Local fixture with a self-signed certificate.
      options: { encrypt: false, trustServerCertificate: true },
      requestTimeout: 300_000,
    };
  }

  async connect(): Promise<void> {
    const bootstrap = await new sql.ConnectionPool(this.config('master')).connect();
    try {
      await bootstrap.request().batch(`
        if db_id(N'benchmark') is null create database [benchmark];
        alter database [benchmark] set read_committed_snapshot on with rollback immediate;`);
    } finally {
      await bootstrap.close();
    }
    this.pool = await new sql.ConnectionPool(this.config(CONNECTIONS.mssql.database)).connect();
  }

  async close(): Promise<void> {
    await this.pool?.close();
    this.pool = null;
  }

  async describe(): Promise<Record<string, string>> {
    const [v] = await this.q(`select @@version as version,
      (select value_in_use from sys.configurations where name = 'max server memory (MB)') as max_server_memory_mb,
      (select is_read_committed_snapshot_on from sys.databases where name = db_name()) as rcsi`);
    return Object.fromEntries(Object.entries(v ?? {}).map(([k, x]) => [k, String(x)]));
  }

  async resetSchema(): Promise<void> {
    await this.db.request().batch(`
      drop table if exists srv_tx_likes, srv_likes, srv_posts, srv_users, srv_documents,
                           srv_w_plain, srv_w_uk, srv_w_docs;

      create table srv_users (
        id         int           not null primary key,
        email      varchar(255)  not null constraint srv_users_email_uk unique,
        name       varchar(255)  not null,
        score      int           not null,
        created_at datetime2(3)  not null,
        bio        varchar(max)  not null
      );
      create table srv_posts (
        id         int           not null primary key,
        user_id    int           not null,
        title      varchar(255)  not null,
        views      int           not null,
        like_count int           not null default 0,
        created_at datetime2(3)  not null
      );
      create table srv_likes (
        id         int           not null primary key,
        post_id    int           not null,
        user_id    int           not null,
        created_at datetime2(3)  not null
      );
      create table srv_w_plain (
        id int not null primary key, email varchar(255) not null, name varchar(255) not null,
        score int not null, created_at datetime2(3) not null, bio varchar(max) not null
      );
      create table srv_w_uk (
        id int not null primary key, email varchar(255) not null constraint srv_w_uk_email_uk unique,
        name varchar(255) not null, score int not null, created_at datetime2(3) not null, bio varchar(max) not null
      );
      create table srv_tx_likes (
        user_id    int          not null,
        post_id    int          not null,
        created_at datetime2(3) not null,
        constraint srv_tx_likes_pk primary key (user_id, post_id)
      );`);
  }

  private usersTable(name: string): sql.Table {
    const t = new sql.Table(name);
    t.create = false;
    t.columns.add('id', sql.Int, { nullable: false });
    t.columns.add('email', sql.VarChar(255), { nullable: false });
    t.columns.add('name', sql.VarChar(255), { nullable: false });
    t.columns.add('score', sql.Int, { nullable: false });
    t.columns.add('created_at', sql.DateTime2(3), { nullable: false });
    t.columns.add('bio', sql.VarChar(sql.MAX), { nullable: false });
    return t;
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    switch (table) {
      case 'users': {
        const t = this.usersTable('srv_users');
        for (const r of rows) t.rows.add(r.id as number, r.email as string, r.name as string, r.score as number, r.created_at as Date, r.bio as string);
        await this.db.request().bulk(t);
        return;
      }
      case 'posts': {
        const t = new sql.Table('srv_posts');
        t.create = false;
        t.columns.add('id', sql.Int, { nullable: false });
        t.columns.add('user_id', sql.Int, { nullable: false });
        t.columns.add('title', sql.VarChar(255), { nullable: false });
        t.columns.add('views', sql.Int, { nullable: false });
        t.columns.add('like_count', sql.Int, { nullable: false });
        t.columns.add('created_at', sql.DateTime2(3), { nullable: false });
        for (const r of rows) t.rows.add(r.id as number, r.user_id as number, r.title as string, r.views as number, r.like_count as number, r.created_at as Date);
        await this.db.request().bulk(t);
        return;
      }
      case 'likes': {
        const t = new sql.Table('srv_likes');
        t.create = false;
        t.columns.add('id', sql.Int, { nullable: false });
        t.columns.add('post_id', sql.Int, { nullable: false });
        t.columns.add('user_id', sql.Int, { nullable: false });
        t.columns.add('created_at', sql.DateTime2(3), { nullable: false });
        for (const r of rows) t.rows.add(r.id as number, r.post_id as number, r.user_id as number, r.created_at as Date);
        await this.db.request().bulk(t);
        return;
      }
      case 'documents':
        return; // no JSON type: R10 and W4 are N/A
    }
  }

  async afterLoad(): Promise<void> {
    await this.db.request().batch(`
      create index srv_users_created_at_idx on srv_users (created_at);
      create index srv_posts_user_id_idx on srv_posts (user_id);
      create index srv_posts_created_at_idx on srv_posts (created_at);
      create index srv_likes_post_id_idx on srv_likes (post_id);
      create index srv_likes_user_id_idx on srv_likes (user_id);
      update statistics srv_users; update statistics srv_posts; update statistics srv_likes;`);
  }

  async createIndex(kind: IndexKind): Promise<void> {
    if (kind !== 'name-prefix') throw this.notSupported(`index ${kind}`, kind === 'fulltext' ? NO_FULLTEXT : NO_JSON);
    await this.db.request().batch(`
      if not exists (select 1 from sys.indexes where name = 'srv_users_name_idx')
        create index srv_users_name_idx on srv_users (name);
      update statistics srv_users;`);
  }

  async dropIndex(kind: IndexKind): Promise<void> {
    if (kind !== 'name-prefix') return;
    await this.db.request().batch('drop index if exists srv_users_name_idx on srv_users');
  }

  async truncateScratch(table: ScratchTable): Promise<void> {
    switch (table) {
      case 'w_plain':
        await this.db.request().batch('truncate table srv_w_plain');
        break;
      case 'w_uk':
        await this.db.request().batch('truncate table srv_w_uk');
        break;
      case 'w_docs':
        break;
      case 'tx_likes':
        await this.db.request().batch('truncate table srv_tx_likes; update srv_posts set like_count = 0 where like_count <> 0;');
        break;
    }
  }

  // ---------------------------------------------------------------- reads --

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    const p = { lim: q.limit, off: q.offset, after: q.after };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select top (@lim) u.* from srv_users u order by u.id', p), 'id');
      case 'simple/offset':
        return page(await this.q('select u.* from srv_users u order by u.id offset @off rows fetch next @lim rows only', p), 'id');
      case 'simple/cursor':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.id > @after order by u.id', p), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id`, p), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id offset @off rows fetch next @lim rows only`, p), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where p.id > @after
          order by p.id`, p), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id`, p), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id offset @off rows fetch next @lim rows only`, p), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where l.id > @after
          order by l.id`, p), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    const p = { lim: q.limit, off: q.offset, after: q.after, email };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.email = @email order by u.id', p), 'id');
      case 'simple/offset':
        return page(await this.q(
          'select u.* from srv_users u where u.email = @email order by u.id offset @off rows fetch next @lim rows only', p), 'id');
      case 'simple/cursor':
        return page(await this.q(
          'select top (@lim) u.* from srv_users u where u.email = @email and u.id > @after order by u.id', p), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = @email
          order by p.id`, p), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = @email
          order by p.id offset @off rows fetch next @lim rows only`, p), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = @email and p.id > @after
          order by p.id`, p), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = @email
          order by l.id`, p), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = @email
          order by l.id offset @off rows fetch next @lim rows only`, p), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = @email and l.id > @after
          order by l.id`, p), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    const p = { lim: q.limit, off: q.offset, after: q.after, cutoff };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.score < @cutoff order by u.id', p), 'id');
      case 'simple/offset':
        return page(await this.q(
          'select u.* from srv_users u where u.score < @cutoff order by u.id offset @off rows fetch next @lim rows only', p), 'id');
      case 'simple/cursor':
        return page(await this.q(
          'select top (@lim) u.* from srv_users u where u.score < @cutoff and u.id > @after order by u.id', p), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < @cutoff
          order by p.id`, p), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < @cutoff
          order by p.id offset @off rows fetch next @lim rows only`, p), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < @cutoff and p.id > @after
          order by p.id`, p), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < @cutoff
          order by l.id`, p), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < @cutoff
          order by l.id offset @off rows fetch next @lim rows only`, p), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < @cutoff and l.id > @after
          order by l.id`, p), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    switch (shape) {
      case 'simple':
        return page(await this.q('select u.* from srv_users u where u.id = @id', { id }), 'id');
      case 'single-join':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.id = @id`, { id }), 'post_id');
      case 'multi-join':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.id = @id`, { id }), 'like_id');
    }
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    return page(await this.q(
      'select u.* from srv_users u where u.id in (select cast(value as int) from openjson(@ids))',
      { ids: JSON.stringify(ids) }), 'id');
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    const p = { lim: q.limit, off: q.offset, after: q.after, from, to };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q(
          'select top (@lim) u.* from srv_users u where u.created_at between @from and @to order by u.id', p), 'id');
      case 'simple/offset':
        return page(await this.q(`
          select u.* from srv_users u where u.created_at between @from and @to
          order by u.id offset @off rows fetch next @lim rows only`, p), 'id');
      case 'simple/cursor':
        return page(await this.q(`
          select top (@lim) u.* from srv_users u where u.created_at between @from and @to and u.id > @after
          order by u.id`, p), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between @from and @to
          order by p.id`, p), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between @from and @to
          order by p.id offset @off rows fetch next @lim rows only`, p), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between @from and @to and p.id > @after
          order by p.id`, p), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between @from and @to
          order by l.id`, p), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between @from and @to
          order by l.id offset @off rows fetch next @lim rows only`, p), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between @from and @to and l.id > @after
          order by l.id`, p), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    switch (variant) {
      case 'count-all':
        return { rows: (await this.q('select count_big(*) as n from srv_users')).length };
      case 'count-indexed':
        return { rows: (await this.q('select count_big(*) as n from srv_users where created_at between @from and @to', { from: a.from, to: a.to })).length };
      case 'count-unindexed':
        return { rows: (await this.q('select count_big(*) as n from srv_users where score < @cutoff', { cutoff: a.cutoff })).length };
      case 'sum-views':
        return { rows: (await this.q('select sum(cast(views as bigint)) as total from srv_posts')).length };
      case 'posts-per-user':
        return { rows: (await this.q(`
          select u.id, count(p.id) as posts
          from srv_users u join srv_posts p on p.user_id = u.id
          group by u.id`)).length };
      case 'likes-per-post':
        return { rows: (await this.q(`
          select p.id, count(l.id) as likes
          from srv_posts p join srv_likes l on l.post_id = p.id
          group by p.id`)).length };
      case 'likes-per-user':
        return { rows: (await this.q(`
          select u.id, count(l.id) as likes
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          group by u.id`)).length };
    }
  }

  async r8TopN(shape: Shape, key: SortKey, limit: number): Promise<OpResult> {
    const p = { lim: limit };
    switch (`${shape}/${key}`) {
      case 'simple/indexed':
        return page(await this.q('select top (@lim) u.* from srv_users u order by u.created_at desc, u.id', p), 'id');
      case 'simple/unindexed':
        return page(await this.q('select top (@lim) u.* from srv_users u order by u.score desc, u.id', p), 'id');
      case 'single-join/indexed':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.created_at desc, p.id`, p), 'post_id');
      case 'single-join/unindexed':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.score desc, p.id`, p), 'post_id');
      case 'multi-join/indexed':
        return page(await this.q(`
          select top (@lim) u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.created_at desc, l.id`, p), 'like_id');
      case 'multi-join/unindexed':
        return page(await this.q(`
          select top (@lim) u.id, u.score, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.score desc, l.id`, p), 'like_id');
    }
    throw new Error(`unreachable: ${shape}/${key}`);
  }

  async r8FullSort(cap: number): Promise<OpResult> {
    return page(await this.q('select u.* from srv_users u where u.id <= @cap order by u.score, u.id', { cap }), 'id');
  }

  async r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult> {
    switch (pattern) {
      case 'prefix':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.name like @pat', { lim: limit, pat: `${term}%` }), 'id');
      case 'contains':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.name like @pat', { lim: limit, pat: `%${term}%` }), 'id');
      case 'suffix':
        return page(await this.q('select top (@lim) u.* from srv_users u where u.name like @pat', { lim: limit, pat: `%${term}` }), 'id');
    }
  }

  async r9FullText(_term: string, _limit: number): Promise<OpResult> {
    throw this.notSupported('r9-fulltext', NO_FULLTEXT);
  }

  async r10Json(_variant: JsonVariant, _value: string, _limit: number): Promise<OpResult> {
    throw this.notSupported('r10', NO_JSON);
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.q('insert into srv_w_plain (id, email, name, score, created_at, bio) values (@id, @email, @name, @score, @at, @bio)',
      { id: r.id, email: r.email, name: r.name, score: r.score, at: r.created_at, bio: r.bio });
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    try {
      await this.q('insert into srv_w_uk (id, email, name, score, created_at, bio) values (@id, @email, @name, @score, @at, @bio)',
        { id: r.id, email: r.email, name: r.name, score: r.score, at: r.created_at, bio: r.bio });
      return { rows: 1 };
    } catch (err) {
      if (DUPLICATE.has(sqlNumber(err) ?? 0)) throw new UniqueViolation((err as Error).message);
      throw err;
    }
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    const t = this.usersTable('srv_w_plain');
    for (const r of rows) t.rows.add(r.id as number, r.email as string, r.name as string, r.score as number, r.created_at as Date, r.bio as string);
    await this.db.request().bulk(t);
    return { rows: rows.length };
  }

  async w4InsertDoc(_r: Row): Promise<OpResult> {
    throw this.notSupported('w4', NO_JSON);
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(postId: number, userId: number): Promise<LikeOutcome> {
    for (let retries = 0; ; retries++) {
      const tx = new sql.Transaction(this.db);
      await tx.begin();
      try {
        await new sql.Request(tx).input('post', sql.Int, postId)
          .query('update srv_posts set like_count = like_count + 1 where id = @post');
        await new sql.Request(tx).input('post', sql.Int, postId).input('user', sql.Int, userId)
          .query('insert into srv_tx_likes (user_id, post_id, created_at) values (@user, @post, sysutcdatetime())');
        await tx.commit();
        return { rows: 1, conflict: false, retries };
      } catch (err) {
        await tx.rollback().catch(() => {});
        if (DUPLICATE.has(sqlNumber(err) ?? 0)) return { rows: 0, conflict: true, retries };
        if (sqlNumber(err) === DEADLOCK && retries < MAX_RETRIES) continue;
        throw err;
      }
    }
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    const [row] = await this.q(`
      select count(*) as checked,
             coalesce(sum(case when p.like_count <> coalesce(l.c, 0) then 1 else 0 end), 0) as mismatches
      from srv_posts p
      left join (select post_id, count(*) as c from srv_tx_likes group by post_id) l on l.post_id = p.id`);
    return { checked: Number(row?.checked ?? 0), mismatches: Number(row?.mismatches ?? 0) };
  }
}
