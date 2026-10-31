/**
 * Cassandra 5. A partitioned wide-column store, so most of the matrix is
 * honestly N/A here, and every N/A carries its reason:
 *
 *   - no joins and no cross-partition GROUP BY (every non-simple shape, and
 *     three of the R7 aggregates)
 *   - no OFFSET; paging is token(id) order
 *   - ORDER BY only on clustering columns, so top-N and full sort are N/A
 *   - no JSON document type, and text search would need analyzed SAI
 *     indexes that are not configured
 *   - no cross-partition transaction (Accord is Cassandra 6, pre-GA), so the
 *     like transaction is N/A rather than replaced by a weaker operation
 *
 * What runs: single and batch inserts, unique inserts via LWT IF NOT EXISTS,
 * unfiltered limit/token-cursor reads, key lookups, and filtered reads through
 * Storage-Attached Indexes (email, created_at) or ALLOW FILTERING (score).
 */

import cassandra from 'cassandra-driver';
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

const LOAD_CONCURRENCY = 128;

const NO_JOINS = 'Cassandra has no joins';
const NO_OFFSET = 'Cassandra has no OFFSET';
const NO_SORT = 'Cassandra cannot ORDER BY a non-clustering column';
const NO_JSON = 'Cassandra has no JSON document type';
const NO_TEXT = 'text search needs analyzed SAI indexes, which are not configured';
const NO_TX = 'Cassandra 5 has no cross-partition transaction (Accord is Cassandra 6, pre-GA)';
const NO_FILTERED_PAGING = 'paging over a filtered scan is not supported';

const idOf = (row: cassandra.types.Row | undefined): number | null => {
  const v = row?.get('id') as unknown;
  return typeof v === 'number' ? v : null;
};

function page(rs: cassandra.types.ResultSet): OpResult {
  return { rows: rs.rowLength, last: idOf(rs.rows[rs.rows.length - 1]) };
}

export class CassandraEngine extends Engine {
  readonly name = 'cassandra';
  readonly displayName = 'Cassandra';
  private client: cassandra.Client | null = null;

  private get db(): cassandra.Client {
    if (!this.client) throw new Error('cassandra used before connect()');
    return this.client;
  }

  private run(cql: string, params: unknown[] = []): Promise<cassandra.types.ResultSet> {
    return this.db.execute(cql, params, { prepare: true });
  }

  support(op: OpId, p: CellParams): string | null {
    switch (op) {
      case 'r1':
      case 'r4':
        if (p.shape !== 'simple') return NO_JOINS;
        return p.mode === 'offset' ? NO_OFFSET : null;
      case 'r2':
      case 'r3':
      case 'r6':
        if (p.shape !== 'simple') return NO_JOINS;
        return p.mode === 'limit' ? null : NO_FILTERED_PAGING;
      case 'r5-id':
        return p.shape === 'simple' ? null : NO_JOINS;
      case 'r5-multi':
        return null;
      case 'r7':
        return ['count-all', 'count-indexed', 'count-unindexed', 'sum-views'].includes(p.variant ?? '')
          ? null
          : 'Cassandra has no joins or cross-partition GROUP BY';
      case 'r8-topn':
      case 'r8-fullsort':
        return NO_SORT;
      case 'r9-like':
      case 'r9-fulltext':
        return NO_TEXT;
      case 'r10':
      case 'w4':
        return NO_JSON;
      case 'index':
        return p.kind?.startsWith('json') ? NO_JSON : NO_TEXT;
      case 'like':
        return NO_TX;
      case 'w1':
      case 'w2':
      case 'w3':
        return null;
    }
  }

  // ------------------------------------------------------------ lifecycle --

  private newClient(keyspace?: string): cassandra.Client {
    const c = CONNECTIONS.cassandra;
    return new cassandra.Client({
      contactPoints: [`${c.host}:${c.port}`],
      localDataCenter: c.datacenter,
      // Full-table counts and ALLOW FILTERING scans outlast the 12s default.
      socketOptions: { readTimeout: 120_000 },
      pooling: { maxRequestsPerConnection: Math.max(2048, POOL_SIZE * 32) },
      ...(keyspace ? { keyspace } : {}),
    });
  }

  async connect(): Promise<void> {
    const ks = CONNECTIONS.cassandra.keyspace;
    const bootstrap = this.newClient();
    try {
      await bootstrap.connect();
      await bootstrap.execute(
        `create keyspace if not exists ${ks} with replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
      );
    } finally {
      await bootstrap.shutdown();
    }
    this.client = this.newClient(ks);
    await this.client.connect();
  }

  async close(): Promise<void> {
    await this.client?.shutdown();
    this.client = null;
  }

  async describe(): Promise<Record<string, string>> {
    const rs = await this.run('select release_version from system.local');
    return { version: String(rs.first()?.get('release_version') ?? 'unknown') };
  }

  async resetSchema(): Promise<void> {
    for (const t of ['srv_users', 'srv_posts', 'srv_w_plain', 'srv_w_uk']) await this.db.execute(`drop table if exists ${t}`);
    await this.db.execute(`
      create table srv_users (id int primary key, email text, name text, score int, created_at timestamp, bio text)`);
    await this.db.execute(`
      create table srv_posts (id int primary key, user_id int, title text, views int, like_count int, created_at timestamp)`);
    await this.db.execute(`
      create table srv_w_plain (id int primary key, email text, name text, score int, created_at timestamp, bio text)`);
    // Uniqueness in Cassandra is a primary key: email is the key, so IF NOT EXISTS enforces it.
    await this.db.execute(`
      create table srv_w_uk (email text primary key, id int, name text, score int, created_at timestamp, bio text)`);
    // Storage-Attached Indexes: the supported way to filter on non-key columns. score stays unindexed (R3).
    await this.db.execute(`create custom index srv_users_email_sai on srv_users (email) using 'StorageAttachedIndex'`);
    await this.db.execute(`create custom index srv_users_created_sai on srv_users (created_at) using 'StorageAttachedIndex'`);
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    // Bounded-concurrency single-partition writes; a multi-partition BATCH is the Cassandra anti-pattern.
    switch (table) {
      case 'users':
        await cassandra.concurrent.executeConcurrent(this.db,
          'insert into srv_users (id, email, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?)',
          rows.map((r) => [r.id, r.email, r.name, r.score, r.created_at, r.bio]),
          { concurrencyLevel: LOAD_CONCURRENCY });
        return;
      case 'posts':
        await cassandra.concurrent.executeConcurrent(this.db,
          'insert into srv_posts (id, user_id, title, views, like_count, created_at) values (?, ?, ?, ?, ?, ?)',
          rows.map((r) => [r.id, r.user_id, r.title, r.views, r.like_count, r.created_at]),
          { concurrencyLevel: LOAD_CONCURRENCY });
        return;
      case 'likes':
      case 'documents':
        return; // back only joins and JSON, which are N/A here
    }
  }

  async afterLoad(): Promise<void> {
    // SAI indexes were created with the tables and build as rows arrive.
  }

  async createIndex(kind: IndexKind): Promise<void> {
    throw this.notSupported(`index ${kind}`, kind.startsWith('json') ? NO_JSON : NO_TEXT);
  }

  async dropIndex(_kind: IndexKind): Promise<void> {}

  async truncateScratch(table: ScratchTable): Promise<void> {
    if (table === 'w_plain') await this.db.execute('truncate srv_w_plain');
    if (table === 'w_uk') await this.db.execute('truncate srv_w_uk');
  }

  // ---------------------------------------------------------------- reads --

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    if (q.shape !== 'simple') throw this.notSupported('r1', NO_JOINS);
    switch (q.mode) {
      case 'limit':
        return page(await this.run('select id, email, name, score, created_at from srv_users limit ?', [q.limit]));
      case 'cursor':
        return page(await this.run(
          'select id, email, name, score, created_at from srv_users where token(id) > token(?) limit ?', [q.after, q.limit]));
      case 'offset':
        throw this.notSupported('r1', NO_OFFSET);
    }
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    if (q.shape !== 'simple' || q.mode !== 'limit') throw this.notSupported('r2', q.shape !== 'simple' ? NO_JOINS : NO_FILTERED_PAGING);
    return page(await this.run('select id, email, name, score, created_at from srv_users where email = ? limit ?', [email, q.limit]));
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    if (q.shape !== 'simple' || q.mode !== 'limit') throw this.notSupported('r3', q.shape !== 'simple' ? NO_JOINS : NO_FILTERED_PAGING);
    // Deliberately unindexed: a filtered full scan, which is what R3 measures.
    return page(await this.run(
      'select id, email, name, score, created_at from srv_users where score < ? limit ? allow filtering', [cutoff, q.limit]));
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    if (shape !== 'simple') throw this.notSupported('r5-id', NO_JOINS);
    return page(await this.run('select id, email, name, score, created_at from srv_users where id = ?', [id]));
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    return page(await this.run('select id, email, name, score, created_at from srv_users where id in ?', [ids]));
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    if (q.shape !== 'simple' || q.mode !== 'limit') throw this.notSupported('r6', q.shape !== 'simple' ? NO_JOINS : NO_FILTERED_PAGING);
    return page(await this.run(
      'select id, email, name, score, created_at from srv_users where created_at >= ? and created_at <= ? limit ?',
      [from, to, q.limit]));
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    switch (variant) {
      case 'count-all':
        return { rows: (await this.run('select count(*) as n from srv_users')).rowLength };
      case 'count-indexed':
        return { rows: (await this.run(
          'select count(*) as n from srv_users where created_at >= ? and created_at <= ?', [a.from, a.to])).rowLength };
      case 'count-unindexed':
        return { rows: (await this.run('select count(*) as n from srv_users where score < ? allow filtering', [a.cutoff])).rowLength };
      case 'sum-views':
        return { rows: (await this.run('select sum(views) as total from srv_posts')).rowLength };
      default:
        throw this.notSupported('r7', 'Cassandra has no joins or cross-partition GROUP BY');
    }
  }

  async r8TopN(_shape: Shape, _key: SortKey, _limit: number): Promise<OpResult> {
    throw this.notSupported('r8-topn', NO_SORT);
  }

  async r8FullSort(_cap: number): Promise<OpResult> {
    throw this.notSupported('r8-fullsort', NO_SORT);
  }

  async r9Like(_p: LikePattern, _t: string, _l: number): Promise<OpResult> {
    throw this.notSupported('r9-like', NO_TEXT);
  }

  async r9FullText(_t: string, _l: number): Promise<OpResult> {
    throw this.notSupported('r9-fulltext', NO_TEXT);
  }

  async r10Json(_v: JsonVariant, _value: string, _l: number): Promise<OpResult> {
    throw this.notSupported('r10', NO_JSON);
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.run('insert into srv_w_plain (id, email, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?)',
      [r.id, r.email, r.name, r.score, r.created_at, r.bio]);
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    const rs = await this.run(
      'insert into srv_w_uk (email, id, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?) if not exists',
      [r.email, r.id, r.name, r.score, r.created_at, r.bio]);
    if (rs.first()?.get('[applied]') === false) throw new UniqueViolation('duplicate email (LWT not applied)');
    return { rows: 1 };
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    await cassandra.concurrent.executeConcurrent(this.db,
      'insert into srv_w_plain (id, email, name, score, created_at, bio) values (?, ?, ?, ?, ?, ?)',
      rows.map((r) => [r.id, r.email, r.name, r.score, r.created_at, r.bio]),
      { concurrencyLevel: LOAD_CONCURRENCY });
    return { rows: rows.length };
  }

  async w4InsertDoc(_r: Row): Promise<OpResult> {
    throw this.notSupported('w4', NO_JSON);
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(_postId: number, _userId: number): Promise<LikeOutcome> {
    throw this.notSupported('like', NO_TX);
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    throw this.notSupported('verify', NO_TX);
  }
}
