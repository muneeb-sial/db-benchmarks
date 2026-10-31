/**
 * PostgreSQL. Every query is written out in full for each shape and mode;
 * nothing here is shared with any other engine.
 *
 * Shapes order and page on the key of their most numerous side: u.id for
 * simple, p.id for single-join, l.id for multi-join.
 */

import postgres from 'postgres';
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

const UNIQUE_VIOLATION = '23505';
/** serialization_failure, deadlock_detected */
const RETRYABLE = new Set(['40001', '40P01']);
const MAX_RETRIES = 10;
/** Rows per multi-row INSERT, well under the 65,535 bind-parameter limit. */
const ROWS_PER_INSERT = 5000;

const code = (err: unknown): string | undefined => (err as { code?: string })?.code;

type Rows = readonly Record<string, unknown>[];

function page(rows: Rows, key: string): OpResult {
  const last = rows.length ? Number(rows[rows.length - 1]![key]) : null;
  return { rows: rows.length, last };
}

export class PostgresEngine extends Engine {
  readonly name = 'postgres';
  readonly displayName = 'PostgreSQL';
  private sql: postgres.Sql | null = null;

  private get db(): postgres.Sql {
    if (!this.sql) throw new Error('postgres used before connect()');
    return this.sql;
  }

  support(_op: OpId, _p: CellParams): string | null {
    return null;
  }

  // ------------------------------------------------------------ lifecycle --

  async connect(): Promise<void> {
    const c = CONNECTIONS.postgres;
    this.sql = postgres({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      max: POOL_SIZE,
      onnotice: () => {},
    });
    await this.sql`select 1`;
  }

  async close(): Promise<void> {
    await this.sql?.end();
    this.sql = null;
  }

  async describe(): Promise<Record<string, string>> {
    const rows = await this.db<{ name: string; setting: string; unit: string | null }[]>`
      select name, setting, unit from pg_settings
      where name in ('server_version', 'shared_buffers', 'effective_cache_size', 'work_mem', 'max_connections')`;
    return Object.fromEntries(rows.map((r) => [r.name, r.unit ? `${r.setting}${r.unit}` : r.setting]));
  }

  async resetSchema(): Promise<void> {
    const db = this.db;
    await db`drop table if exists srv_tx_likes, srv_likes, srv_posts, srv_users, srv_documents,
                                  srv_w_plain, srv_w_uk, srv_w_docs`;
    await db`
      create table srv_users (
        id         int          primary key,
        email      varchar(255) not null unique,
        name       varchar(255) not null,
        score      int          not null,
        created_at timestamptz  not null,
        bio        text         not null
      )`;
    await db`
      create table srv_posts (
        id         int          primary key,
        user_id    int          not null,
        title      varchar(255) not null,
        views      int          not null,
        like_count int          not null default 0,
        created_at timestamptz  not null
      )`;
    await db`
      create table srv_likes (
        id         int         primary key,
        post_id    int         not null,
        user_id    int         not null,
        created_at timestamptz not null
      )`;
    await db`create table srv_documents (id int primary key, doc jsonb not null)`;
    await db`
      create table srv_w_plain (
        id int primary key, email varchar(255) not null, name varchar(255) not null,
        score int not null, created_at timestamptz not null, bio text not null
      )`;
    await db`
      create table srv_w_uk (
        id int primary key, email varchar(255) not null unique, name varchar(255) not null,
        score int not null, created_at timestamptz not null, bio text not null
      )`;
    await db`create table srv_w_docs (id int primary key, doc jsonb not null)`;
    await db`
      create table srv_tx_likes (
        user_id    int         not null,
        post_id    int         not null,
        created_at timestamptz not null,
        primary key (user_id, post_id)
      )`;
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    const db = this.db;
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const slice = rows.slice(i, i + ROWS_PER_INSERT);
      switch (table) {
        case 'users':
          await db`insert into srv_users ${db(slice as Record<string, any>[], 'id', 'email', 'name', 'score', 'created_at', 'bio')}`;
          break;
        case 'posts':
          await db`insert into srv_posts ${db(slice as Record<string, any>[], 'id', 'user_id', 'title', 'views', 'like_count', 'created_at')}`;
          break;
        case 'likes':
          await db`insert into srv_likes ${db(slice as Record<string, any>[], 'id', 'post_id', 'user_id', 'created_at')}`;
          break;
        case 'documents':
          await db`insert into srv_documents ${db(slice.map((r) => ({ id: r.id, doc: db.json(r.doc as never) })) as Record<string, any>[], 'id', 'doc')}`;
          break;
      }
    }
  }

  async afterLoad(): Promise<void> {
    const db = this.db;
    await db`create index srv_users_created_at_idx on srv_users (created_at)`;
    await db`create index srv_posts_user_id_idx on srv_posts (user_id)`;
    await db`create index srv_posts_created_at_idx on srv_posts (created_at)`;
    await db`create index srv_likes_post_id_idx on srv_likes (post_id)`;
    await db`create index srv_likes_user_id_idx on srv_likes (user_id)`;
    await db`analyze`;
  }

  async createIndex(kind: IndexKind): Promise<void> {
    const db = this.db;
    switch (kind) {
      case 'name-prefix':
        await db`create index if not exists srv_users_name_prefix_idx on srv_users (name text_pattern_ops)`;
        break;
      case 'fulltext':
        await db`create index if not exists srv_users_bio_fts_idx on srv_users using gin (to_tsvector('simple', bio))`;
        break;
      case 'json-top':
        await db`create index if not exists srv_documents_tag_idx on srv_documents ((doc->>'tag'))`;
        break;
      case 'json-nested':
        // The expression must match r10Json's literally for the planner to use it.
        await db.unsafe(
          `create index if not exists srv_documents_nested_idx on srv_documents ((doc #>> '{${this.docPath.join(',')}}'))`,
        );
        break;
      case 'json-array':
        await db`create index if not exists srv_documents_tags_idx on srv_documents using gin ((doc->'tags'))`;
        break;
    }
    await db`analyze srv_users`;
    await db`analyze srv_documents`;
  }

  async dropIndex(kind: IndexKind): Promise<void> {
    const db = this.db;
    switch (kind) {
      case 'name-prefix':
        await db`drop index if exists srv_users_name_prefix_idx`;
        break;
      case 'fulltext':
        await db`drop index if exists srv_users_bio_fts_idx`;
        break;
      case 'json-top':
        await db`drop index if exists srv_documents_tag_idx`;
        break;
      case 'json-nested':
        await db`drop index if exists srv_documents_nested_idx`;
        break;
      case 'json-array':
        await db`drop index if exists srv_documents_tags_idx`;
        break;
    }
  }

  async truncateScratch(table: ScratchTable): Promise<void> {
    const db = this.db;
    switch (table) {
      case 'w_plain':
        await db`truncate srv_w_plain`;
        break;
      case 'w_uk':
        await db`truncate srv_w_uk`;
        break;
      case 'w_docs':
        await db`truncate srv_w_docs`;
        break;
      case 'tx_likes':
        await db`truncate srv_tx_likes`;
        await db`update srv_posts set like_count = 0 where like_count <> 0`;
        break;
    }
  }

  // ---------------------------------------------------------------- reads --

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    const db = this.db;
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await db`select u.* from srv_users u order by u.id limit ${q.limit}`, 'id');
      case 'simple/offset':
        return page(await db`select u.* from srv_users u order by u.id limit ${q.limit} offset ${q.offset}`, 'id');
      case 'simple/cursor':
        return page(await db`select u.* from srv_users u where u.id > ${q.after} order by u.id limit ${q.limit}`, 'id');

      case 'single-join/limit':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id limit ${q.limit}`, 'post_id');
      case 'single-join/offset':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id limit ${q.limit} offset ${q.offset}`, 'post_id');
      case 'single-join/cursor':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where p.id > ${q.after}
          order by p.id limit ${q.limit}`, 'post_id');

      case 'multi-join/limit':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id limit ${q.limit}`, 'like_id');
      case 'multi-join/offset':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id limit ${q.limit} offset ${q.offset}`, 'like_id');
      case 'multi-join/cursor':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where l.id > ${q.after}
          order by l.id limit ${q.limit}`, 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    const db = this.db;
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await db`select u.* from srv_users u where u.email = ${email} order by u.id limit ${q.limit}`, 'id');
      case 'simple/offset':
        return page(await db`
          select u.* from srv_users u where u.email = ${email}
          order by u.id limit ${q.limit} offset ${q.offset}`, 'id');
      case 'simple/cursor':
        return page(await db`
          select u.* from srv_users u where u.email = ${email} and u.id > ${q.after}
          order by u.id limit ${q.limit}`, 'id');

      case 'single-join/limit':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ${email}
          order by p.id limit ${q.limit}`, 'post_id');
      case 'single-join/offset':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ${email}
          order by p.id limit ${q.limit} offset ${q.offset}`, 'post_id');
      case 'single-join/cursor':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ${email} and p.id > ${q.after}
          order by p.id limit ${q.limit}`, 'post_id');

      case 'multi-join/limit':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ${email}
          order by l.id limit ${q.limit}`, 'like_id');
      case 'multi-join/offset':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ${email}
          order by l.id limit ${q.limit} offset ${q.offset}`, 'like_id');
      case 'multi-join/cursor':
        return page(await db`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ${email} and l.id > ${q.after}
          order by l.id limit ${q.limit}`, 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    const db = this.db;
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await db`select u.* from srv_users u where u.score < ${cutoff} order by u.id limit ${q.limit}`, 'id');
      case 'simple/offset':
        return page(await db`
          select u.* from srv_users u where u.score < ${cutoff}
          order by u.id limit ${q.limit} offset ${q.offset}`, 'id');
      case 'simple/cursor':
        return page(await db`
          select u.* from srv_users u where u.score < ${cutoff} and u.id > ${q.after}
          order by u.id limit ${q.limit}`, 'id');

      case 'single-join/limit':
        return page(await db`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ${cutoff}
          order by p.id limit ${q.limit}`, 'post_id');
      case 'single-join/offset':
        return page(await db`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ${cutoff}
          order by p.id limit ${q.limit} offset ${q.offset}`, 'post_id');
      case 'single-join/cursor':
        return page(await db`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ${cutoff} and p.id > ${q.after}
          order by p.id limit ${q.limit}`, 'post_id');

      case 'multi-join/limit':
        return page(await db`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ${cutoff}
          order by l.id limit ${q.limit}`, 'like_id');
      case 'multi-join/offset':
        return page(await db`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ${cutoff}
          order by l.id limit ${q.limit} offset ${q.offset}`, 'like_id');
      case 'multi-join/cursor':
        return page(await db`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ${cutoff} and l.id > ${q.after}
          order by l.id limit ${q.limit}`, 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    const db = this.db;
    switch (shape) {
      case 'simple':
        return page(await db`select u.* from srv_users u where u.id = ${id}`, 'id');
      case 'single-join':
        return page(await db`
          select u.id, u.email, u.name, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.id = ${id}`, 'post_id');
      case 'multi-join':
        return page(await db`
          select u.id, u.email, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.id = ${id}`, 'like_id');
    }
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    return page(await this.db`select u.* from srv_users u where u.id = any(${ids}::int[])`, 'id');
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    const db = this.db;
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await db`
          select u.* from srv_users u where u.created_at between ${from} and ${to}
          order by u.id limit ${q.limit}`, 'id');
      case 'simple/offset':
        return page(await db`
          select u.* from srv_users u where u.created_at between ${from} and ${to}
          order by u.id limit ${q.limit} offset ${q.offset}`, 'id');
      case 'simple/cursor':
        return page(await db`
          select u.* from srv_users u where u.created_at between ${from} and ${to} and u.id > ${q.after}
          order by u.id limit ${q.limit}`, 'id');

      case 'single-join/limit':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ${from} and ${to}
          order by p.id limit ${q.limit}`, 'post_id');
      case 'single-join/offset':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ${from} and ${to}
          order by p.id limit ${q.limit} offset ${q.offset}`, 'post_id');
      case 'single-join/cursor':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ${from} and ${to} and p.id > ${q.after}
          order by p.id limit ${q.limit}`, 'post_id');

      case 'multi-join/limit':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ${from} and ${to}
          order by l.id limit ${q.limit}`, 'like_id');
      case 'multi-join/offset':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ${from} and ${to}
          order by l.id limit ${q.limit} offset ${q.offset}`, 'like_id');
      case 'multi-join/cursor':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ${from} and ${to} and l.id > ${q.after}
          order by l.id limit ${q.limit}`, 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    const db = this.db;
    switch (variant) {
      case 'count-all':
        return { rows: (await db`select count(*) as n from srv_users`).length };
      case 'count-indexed':
        return { rows: (await db`select count(*) as n from srv_users where created_at between ${a.from} and ${a.to}`).length };
      case 'count-unindexed':
        return { rows: (await db`select count(*) as n from srv_users where score < ${a.cutoff}`).length };
      case 'sum-views':
        return { rows: (await db`select sum(views) as total from srv_posts`).length };
      case 'posts-per-user':
        return { rows: (await db`
          select u.id, count(p.id) as posts
          from srv_users u join srv_posts p on p.user_id = u.id
          group by u.id`).length };
      case 'likes-per-post':
        return { rows: (await db`
          select p.id, count(l.id) as likes
          from srv_posts p join srv_likes l on l.post_id = p.id
          group by p.id`).length };
      case 'likes-per-user':
        return { rows: (await db`
          select u.id, count(l.id) as likes
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          group by u.id`).length };
    }
  }

  async r8TopN(shape: Shape, key: SortKey, limit: number): Promise<OpResult> {
    const db = this.db;
    switch (`${shape}/${key}`) {
      case 'simple/indexed':
        return page(await db`select u.* from srv_users u order by u.created_at desc, u.id limit ${limit}`, 'id');
      case 'simple/unindexed':
        return page(await db`select u.* from srv_users u order by u.score desc, u.id limit ${limit}`, 'id');
      case 'single-join/indexed':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.created_at desc, p.id limit ${limit}`, 'post_id');
      case 'single-join/unindexed':
        return page(await db`
          select u.id, u.score, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.score desc, p.id limit ${limit}`, 'post_id');
      case 'multi-join/indexed':
        return page(await db`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.created_at desc, l.id limit ${limit}`, 'like_id');
      case 'multi-join/unindexed':
        return page(await db`
          select u.id, u.score, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.score desc, l.id limit ${limit}`, 'like_id');
    }
    throw new Error(`unreachable: ${shape}/${key}`);
  }

  async r8FullSort(cap: number): Promise<OpResult> {
    return page(await this.db`select u.* from srv_users u where u.id <= ${cap} order by u.score, u.id`, 'id');
  }

  async r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult> {
    const db = this.db;
    switch (pattern) {
      case 'prefix':
        return page(await db`select u.* from srv_users u where u.name like ${term + '%'} limit ${limit}`, 'id');
      case 'contains':
        return page(await db`select u.* from srv_users u where u.name like ${'%' + term + '%'} limit ${limit}`, 'id');
      case 'suffix':
        return page(await db`select u.* from srv_users u where u.name like ${'%' + term} limit ${limit}`, 'id');
    }
  }

  async r9FullText(term: string, limit: number): Promise<OpResult> {
    return page(await this.db`
      select u.* from srv_users u
      where to_tsvector('simple', u.bio) @@ plainto_tsquery('simple', ${term})
      limit ${limit}`, 'id');
  }

  async r10Json(variant: JsonVariant, value: string, limit: number): Promise<OpResult> {
    const db = this.db;
    switch (variant) {
      case 'top-level':
        return page(await db`select d.* from srv_documents d where d.doc->>'tag' = ${value} limit ${limit}`, 'id');
      case 'nested':
        // Literal path, so it matches the expression index from createIndex('json-nested').
        return page(await db.unsafe(
          `select d.* from srv_documents d where d.doc #>> '{${this.docPath.join(',')}}' = $1 limit $2`,
          [value, limit],
        ), 'id');
      case 'array-contains':
        return page(await db`select d.* from srv_documents d where d.doc->'tags' ? ${value} limit ${limit}`, 'id');
    }
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.db`
      insert into srv_w_plain (id, email, name, score, created_at, bio)
      values (${r.id as number}, ${r.email as string}, ${r.name as string}, ${r.score as number},
              ${r.created_at as Date}, ${r.bio as string})`;
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    try {
      await this.db`
        insert into srv_w_uk (id, email, name, score, created_at, bio)
        values (${r.id as number}, ${r.email as string}, ${r.name as string}, ${r.score as number},
                ${r.created_at as Date}, ${r.bio as string})`;
      return { rows: 1 };
    } catch (err) {
      if (code(err) === UNIQUE_VIOLATION) throw new UniqueViolation((err as Error).message);
      throw err;
    }
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    const db = this.db;
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const slice = rows.slice(i, i + ROWS_PER_INSERT);
      await db`insert into srv_w_plain ${db(slice as Record<string, any>[], 'id', 'email', 'name', 'score', 'created_at', 'bio')}`;
    }
    return { rows: rows.length };
  }

  async w4InsertDoc(r: Row): Promise<OpResult> {
    await this.db`insert into srv_w_docs (id, doc) values (${r.id as number}, ${this.db.json(r.doc as never)})`;
    return { rows: 1 };
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(postId: number, userId: number): Promise<LikeOutcome> {
    for (let retries = 0; ; retries++) {
      try {
        await this.db.begin(async (tx) => {
          // posts first, then likes -- the same order in every engine.
          await tx`update srv_posts set like_count = like_count + 1 where id = ${postId}`;
          await tx`insert into srv_tx_likes (user_id, post_id, created_at) values (${userId}, ${postId}, now())`;
        });
        return { rows: 1, conflict: false, retries };
      } catch (err) {
        // The pair already existed; the rollback also undid the increment.
        if (code(err) === UNIQUE_VIOLATION) return { rows: 0, conflict: true, retries };
        if (RETRYABLE.has(code(err) ?? '') && retries < MAX_RETRIES) continue;
        throw err;
      }
    }
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    const [row] = await this.db<{ checked: string; mismatches: string }[]>`
      select count(*) as checked,
             count(*) filter (where p.like_count <> coalesce(l.c, 0)) as mismatches
      from srv_posts p
      left join (select post_id, count(*)::int as c from srv_tx_likes group by post_id) l on l.post_id = p.id`;
    return { checked: Number(row?.checked ?? 0), mismatches: Number(row?.mismatches ?? 0) };
  }
}
