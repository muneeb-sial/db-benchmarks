/**
 * MySQL 8. Every query is written out in full for each shape and mode;
 * nothing here is shared with any other engine.
 *
 * The compose file pins READ-COMMITTED, so the like transaction is not
 * measuring REPEATABLE READ gap locks. JSON indexes are functional /
 * multi-valued indexes, and only help when the query repeats the indexed
 * expression exactly -- so the expressions below are written to match.
 */

import mysql from 'mysql2/promise';
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

const ER_DUP_ENTRY = 1062;
const ER_DUP_KEYNAME = 1061;
const ER_CANT_DROP_FIELD_OR_KEY = 1091;
/** ER_LOCK_DEADLOCK, ER_LOCK_WAIT_TIMEOUT */
const RETRYABLE = new Set([1213, 1205]);
const MAX_RETRIES = 10;
/** Rows per multi-row INSERT, kept well under max_allowed_packet. */
const ROWS_PER_INSERT = 5000;

const errno = (err: unknown): number | undefined => (err as { errno?: number })?.errno;

type Rows = Record<string, unknown>[];

function page(rows: Rows, key: string): OpResult {
  const last = rows.length ? Number(rows[rows.length - 1]![key]) : null;
  return { rows: rows.length, last };
}

export class MySqlEngine extends Engine {
  readonly name = 'mysql';
  readonly displayName = 'MySQL';
  private pool: mysql.Pool | null = null;

  private get db(): mysql.Pool {
    if (!this.pool) throw new Error('mysql used before connect()');
    return this.pool;
  }

  private async q(text: string, params: unknown[] = []): Promise<Rows> {
    const [rows] = await this.db.query(text, params);
    return rows as Rows;
  }

  /** Everything runs. Note r9-fulltext needs the FULLTEXT index: MATCH errors without one. */
  support(_op: OpId, _p: CellParams): string | null {
    return null;
  }

  // ------------------------------------------------------------ lifecycle --

  async connect(): Promise<void> {
    const c = CONNECTIONS.mysql;
    this.pool = mysql.createPool({
      host: c.host,
      port: c.port,
      user: c.user,
      password: c.password,
      database: c.database,
      connectionLimit: POOL_SIZE,
      waitForConnections: true,
      decimalNumbers: true,
      // Dates go in and come out as UTC, matching the seed files.
      timezone: 'Z',
    });
    await this.db.query('select 1');
  }

  async close(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  async describe(): Promise<Record<string, string>> {
    const rows = await this.q(
      `show variables where variable_name in
       ('version', 'innodb_buffer_pool_size', 'transaction_isolation', 'max_connections')`,
    );
    return Object.fromEntries(rows.map((r) => [String(r.Variable_name), String(r.Value)]));
  }

  async resetSchema(): Promise<void> {
    await this.q(`drop table if exists srv_tx_likes, srv_likes, srv_posts, srv_users, srv_documents,
                                       srv_w_plain, srv_w_uk, srv_w_docs`);
    await this.q(`
      create table srv_users (
        id         int          primary key,
        email      varchar(255) not null,
        name       varchar(255) not null,
        score      int          not null,
        created_at datetime(3)  not null,
        bio        text         not null,
        unique key srv_users_email_uk (email)
      ) engine = InnoDB`);
    await this.q(`
      create table srv_posts (
        id         int          primary key,
        user_id    int          not null,
        title      varchar(255) not null,
        views      int          not null,
        like_count int          not null default 0,
        created_at datetime(3)  not null
      ) engine = InnoDB`);
    await this.q(`
      create table srv_likes (
        id         int         primary key,
        post_id    int         not null,
        user_id    int         not null,
        created_at datetime(3) not null
      ) engine = InnoDB`);
    await this.q(`create table srv_documents (id int primary key, doc json not null) engine = InnoDB`);
    await this.q(`
      create table srv_w_plain (
        id int primary key, email varchar(255) not null, name varchar(255) not null,
        score int not null, created_at datetime(3) not null, bio text not null
      ) engine = InnoDB`);
    await this.q(`
      create table srv_w_uk (
        id int primary key, email varchar(255) not null, name varchar(255) not null,
        score int not null, created_at datetime(3) not null, bio text not null,
        unique key srv_w_uk_email_uk (email)
      ) engine = InnoDB`);
    await this.q(`create table srv_w_docs (id int primary key, doc json not null) engine = InnoDB`);
    await this.q(`
      create table srv_tx_likes (
        user_id    int         not null,
        post_id    int         not null,
        created_at datetime(3) not null,
        primary key (user_id, post_id)
      ) engine = InnoDB`);
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const s = rows.slice(i, i + ROWS_PER_INSERT);
      switch (table) {
        case 'users':
          await this.q('insert into srv_users (id, email, name, score, created_at, bio) values ?',
            [s.map((r) => [r.id, r.email, r.name, r.score, r.created_at, r.bio])]);
          break;
        case 'posts':
          await this.q('insert into srv_posts (id, user_id, title, views, like_count, created_at) values ?',
            [s.map((r) => [r.id, r.user_id, r.title, r.views, r.like_count, r.created_at])]);
          break;
        case 'likes':
          await this.q('insert into srv_likes (id, post_id, user_id, created_at) values ?',
            [s.map((r) => [r.id, r.post_id, r.user_id, r.created_at])]);
          break;
        case 'documents':
          // mysql2 binds JSON as text.
          await this.q('insert into srv_documents (id, doc) values ?', [s.map((r) => [r.id, JSON.stringify(r.doc)])]);
          break;
      }
    }
  }

  async afterLoad(): Promise<void> {
    await this.q('create index srv_users_created_at_idx on srv_users (created_at)');
    await this.q('create index srv_posts_user_id_idx on srv_posts (user_id)');
    await this.q('create index srv_posts_created_at_idx on srv_posts (created_at)');
    await this.q('create index srv_likes_post_id_idx on srv_likes (post_id)');
    await this.q('create index srv_likes_user_id_idx on srv_likes (user_id)');
    await this.q('analyze table srv_users, srv_posts, srv_likes, srv_documents');
  }

  private nestedJsonPath(): string {
    return `$.${this.docPath.join('.')}`;
  }

  async createIndex(kind: IndexKind): Promise<void> {
    try {
      switch (kind) {
        case 'name-prefix':
          await this.q('create index srv_users_name_idx on srv_users (name)');
          break;
        case 'fulltext':
          await this.q('create fulltext index srv_users_bio_ft on srv_users (bio)');
          break;
        case 'json-top':
          await this.q(`create index srv_documents_tag_idx on srv_documents ((cast(doc->>'$.tag' as char(64))))`);
          break;
        case 'json-nested':
          await this.q(
            `create index srv_documents_nested_idx on srv_documents ((cast(doc->>'${this.nestedJsonPath()}' as char(64))))`,
          );
          break;
        case 'json-array':
          await this.q(`create index srv_documents_tags_idx on srv_documents ((cast(doc->'$.tags' as char(64) array)))`);
          break;
      }
    } catch (err) {
      if (errno(err) !== ER_DUP_KEYNAME) throw err;
    }
    await this.q('analyze table srv_users, srv_documents');
  }

  async dropIndex(kind: IndexKind): Promise<void> {
    try {
      switch (kind) {
        case 'name-prefix':
          await this.q('drop index srv_users_name_idx on srv_users');
          break;
        case 'fulltext':
          await this.q('drop index srv_users_bio_ft on srv_users');
          break;
        case 'json-top':
          await this.q('drop index srv_documents_tag_idx on srv_documents');
          break;
        case 'json-nested':
          await this.q('drop index srv_documents_nested_idx on srv_documents');
          break;
        case 'json-array':
          await this.q('drop index srv_documents_tags_idx on srv_documents');
          break;
      }
    } catch (err) {
      if (errno(err) !== ER_CANT_DROP_FIELD_OR_KEY) throw err;
    }
  }

  async truncateScratch(table: ScratchTable): Promise<void> {
    switch (table) {
      case 'w_plain':
        await this.q('truncate table srv_w_plain');
        break;
      case 'w_uk':
        await this.q('truncate table srv_w_uk');
        break;
      case 'w_docs':
        await this.q('truncate table srv_w_docs');
        break;
      case 'tx_likes':
        await this.q('truncate table srv_tx_likes');
        await this.q('update srv_posts set like_count = 0 where like_count <> 0');
        break;
    }
  }

  // ---------------------------------------------------------------- reads --

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select u.* from srv_users u order by u.id limit ?', [q.limit]), 'id');
      case 'simple/offset':
        return page(await this.q('select u.* from srv_users u order by u.id limit ? offset ?', [q.limit, q.offset]), 'id');
      case 'simple/cursor':
        return page(await this.q('select u.* from srv_users u where u.id > ? order by u.id limit ?', [q.after, q.limit]), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id limit ?`, [q.limit]), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          order by p.id limit ? offset ?`, [q.limit, q.offset]), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where p.id > ?
          order by p.id limit ?`, [q.after, q.limit]), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id limit ?`, [q.limit]), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by l.id limit ? offset ?`, [q.limit, q.offset]), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where l.id > ?
          order by l.id limit ?`, [q.after, q.limit]), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select u.* from srv_users u where u.email = ? order by u.id limit ?', [email, q.limit]), 'id');
      case 'simple/offset':
        return page(await this.q(
          'select u.* from srv_users u where u.email = ? order by u.id limit ? offset ?', [email, q.limit, q.offset]), 'id');
      case 'simple/cursor':
        return page(await this.q(
          'select u.* from srv_users u where u.email = ? and u.id > ? order by u.id limit ?', [email, q.after, q.limit]), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ?
          order by p.id limit ?`, [email, q.limit]), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ?
          order by p.id limit ? offset ?`, [email, q.limit, q.offset]), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.email = ? and p.id > ?
          order by p.id limit ?`, [email, q.after, q.limit]), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ?
          order by l.id limit ?`, [email, q.limit]), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ?
          order by l.id limit ? offset ?`, [email, q.limit, q.offset]), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, p.title, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.email = ? and l.id > ?
          order by l.id limit ?`, [email, q.after, q.limit]), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q('select u.* from srv_users u where u.score < ? order by u.id limit ?', [cutoff, q.limit]), 'id');
      case 'simple/offset':
        return page(await this.q(
          'select u.* from srv_users u where u.score < ? order by u.id limit ? offset ?', [cutoff, q.limit, q.offset]), 'id');
      case 'simple/cursor':
        return page(await this.q(
          'select u.* from srv_users u where u.score < ? and u.id > ? order by u.id limit ?', [cutoff, q.after, q.limit]), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ?
          order by p.id limit ?`, [cutoff, q.limit]), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ?
          order by p.id limit ? offset ?`, [cutoff, q.limit, q.offset]), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, p.title, p.views
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.score < ? and p.id > ?
          order by p.id limit ?`, [cutoff, q.after, q.limit]), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ?
          order by l.id limit ?`, [cutoff, q.limit]), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ?
          order by l.id limit ? offset ?`, [cutoff, q.limit, q.offset]), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, l.id as like_id, l.created_at as liked_at
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.score < ? and l.id > ?
          order by l.id limit ?`, [cutoff, q.after, q.limit]), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    switch (shape) {
      case 'simple':
        return page(await this.q('select u.* from srv_users u where u.id = ?', [id]), 'id');
      case 'single-join':
        return page(await this.q(`
          select u.id, u.email, u.name, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.id = ?`, [id]), 'post_id');
      case 'multi-join':
        return page(await this.q(`
          select u.id, u.email, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.id = ?`, [id]), 'like_id');
    }
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    // mysql2 expands an array bound to `in (?)` into a value list.
    return page(await this.q('select u.* from srv_users u where u.id in (?)', [ids]), 'id');
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await this.q(
          'select u.* from srv_users u where u.created_at between ? and ? order by u.id limit ?', [from, to, q.limit]), 'id');
      case 'simple/offset':
        return page(await this.q(
          'select u.* from srv_users u where u.created_at between ? and ? order by u.id limit ? offset ?',
          [from, to, q.limit, q.offset]), 'id');
      case 'simple/cursor':
        return page(await this.q(
          'select u.* from srv_users u where u.created_at between ? and ? and u.id > ? order by u.id limit ?',
          [from, to, q.after, q.limit]), 'id');

      case 'single-join/limit':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ? and ?
          order by p.id limit ?`, [from, to, q.limit]), 'post_id');
      case 'single-join/offset':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ? and ?
          order by p.id limit ? offset ?`, [from, to, q.limit, q.offset]), 'post_id');
      case 'single-join/cursor':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          where u.created_at between ? and ? and p.id > ?
          order by p.id limit ?`, [from, to, q.after, q.limit]), 'post_id');

      case 'multi-join/limit':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ? and ?
          order by l.id limit ?`, [from, to, q.limit]), 'like_id');
      case 'multi-join/offset':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ? and ?
          order by l.id limit ? offset ?`, [from, to, q.limit, q.offset]), 'like_id');
      case 'multi-join/cursor':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          where u.created_at between ? and ? and l.id > ?
          order by l.id limit ?`, [from, to, q.after, q.limit]), 'like_id');
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    switch (variant) {
      case 'count-all':
        return { rows: (await this.q('select count(*) as n from srv_users')).length };
      case 'count-indexed':
        return { rows: (await this.q('select count(*) as n from srv_users where created_at between ? and ?', [a.from, a.to])).length };
      case 'count-unindexed':
        return { rows: (await this.q('select count(*) as n from srv_users where score < ?', [a.cutoff])).length };
      case 'sum-views':
        return { rows: (await this.q('select sum(views) as total from srv_posts')).length };
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
    switch (`${shape}/${key}`) {
      case 'simple/indexed':
        return page(await this.q('select u.* from srv_users u order by u.created_at desc, u.id limit ?', [limit]), 'id');
      case 'simple/unindexed':
        return page(await this.q('select u.* from srv_users u order by u.score desc, u.id limit ?', [limit]), 'id');
      case 'single-join/indexed':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.created_at desc, p.id limit ?`, [limit]), 'post_id');
      case 'single-join/unindexed':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, p.title
          from srv_users u join srv_posts p on p.user_id = u.id
          order by u.score desc, p.id limit ?`, [limit]), 'post_id');
      case 'multi-join/indexed':
        return page(await this.q(`
          select u.id, u.created_at, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.created_at desc, l.id limit ?`, [limit]), 'like_id');
      case 'multi-join/unindexed':
        return page(await this.q(`
          select u.id, u.score, p.id as post_id, l.id as like_id
          from srv_users u
          join srv_posts p on p.user_id = u.id
          join srv_likes l on l.post_id = p.id
          order by u.score desc, l.id limit ?`, [limit]), 'like_id');
    }
    throw new Error(`unreachable: ${shape}/${key}`);
  }

  async r8FullSort(cap: number): Promise<OpResult> {
    return page(await this.q('select u.* from srv_users u where u.id <= ? order by u.score, u.id', [cap]), 'id');
  }

  async r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult> {
    switch (pattern) {
      case 'prefix':
        return page(await this.q('select u.* from srv_users u where u.name like ? limit ?', [`${term}%`, limit]), 'id');
      case 'contains':
        return page(await this.q('select u.* from srv_users u where u.name like ? limit ?', [`%${term}%`, limit]), 'id');
      case 'suffix':
        return page(await this.q('select u.* from srv_users u where u.name like ? limit ?', [`%${term}`, limit]), 'id');
    }
  }

  async r9FullText(term: string, limit: number): Promise<OpResult> {
    return page(await this.q(
      'select u.* from srv_users u where match(u.bio) against (? in boolean mode) limit ?', [term, limit]), 'id');
  }

  async r10Json(variant: JsonVariant, value: string, limit: number): Promise<OpResult> {
    switch (variant) {
      case 'top-level':
        return page(await this.q(
          `select d.* from srv_documents d where cast(d.doc->>'$.tag' as char(64)) = ? limit ?`, [value, limit]), 'id');
      case 'nested':
        return page(await this.q(
          `select d.* from srv_documents d where cast(d.doc->>'${this.nestedJsonPath()}' as char(64)) = ? limit ?`,
          [value, limit]), 'id');
      case 'array-contains':
        return page(await this.q(
          `select d.* from srv_documents d where ? member of (d.doc->'$.tags') limit ?`, [value, limit]), 'id');
    }
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.q('insert into srv_w_plain (id, email, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?)',
      [r.id, r.email, r.name, r.score, r.created_at, r.bio]);
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    try {
      await this.q('insert into srv_w_uk (id, email, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?)',
        [r.id, r.email, r.name, r.score, r.created_at, r.bio]);
      return { rows: 1 };
    } catch (err) {
      if (errno(err) === ER_DUP_ENTRY) throw new UniqueViolation((err as Error).message);
      throw err;
    }
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
      const s = rows.slice(i, i + ROWS_PER_INSERT);
      await this.q('insert into srv_w_plain (id, email, name, score, created_at, bio) values ?',
        [s.map((r) => [r.id, r.email, r.name, r.score, r.created_at, r.bio])]);
    }
    return { rows: rows.length };
  }

  async w4InsertDoc(r: Row): Promise<OpResult> {
    await this.q('insert into srv_w_docs (id, doc) values (?, ?)', [r.id, JSON.stringify(r.doc)]);
    return { rows: 1 };
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(postId: number, userId: number): Promise<LikeOutcome> {
    for (let retries = 0; ; retries++) {
      const conn = await this.db.getConnection();
      try {
        await conn.beginTransaction();
        // posts first, then likes -- the same order in every engine.
        await conn.query('update srv_posts set like_count = like_count + 1 where id = ?', [postId]);
        await conn.query('insert into srv_tx_likes (user_id, post_id, created_at) values (?, ?, now(3))', [userId, postId]);
        await conn.commit();
        return { rows: 1, conflict: false, retries };
      } catch (err) {
        await conn.rollback().catch(() => {});
        if (errno(err) === ER_DUP_ENTRY) return { rows: 0, conflict: true, retries };
        if (RETRYABLE.has(errno(err) ?? 0) && retries < MAX_RETRIES) continue;
        throw err;
      } finally {
        conn.release();
      }
    }
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    const [row] = await this.q(`
      select count(*) as checked,
             coalesce(sum(p.like_count <> coalesce(l.c, 0)), 0) as mismatches
      from srv_posts p
      left join (select post_id, count(*) as c from srv_tx_likes group by post_id) l on l.post_id = p.id`);
    return { checked: Number(row?.checked ?? 0), mismatches: Number(row?.mismatches ?? 0) };
  }
}
