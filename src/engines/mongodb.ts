/**
 * MongoDB. Each shape and mode is its own find() or aggregation pipeline:
 *
 *   - joins are $lookup + $unwind; unfiltered joins start from the most
 *     numerous collection (posts, likes) so the sort uses its _id index;
 *     filtered joins start from users, where the filter applies
 *   - offset is skip(), cursor is { _id: { $gt: after } }
 *   - LIKE is a regex; full-text is a text index + $text
 *   - documents store their fields at the top level, not under `doc`
 *   - the like transaction needs a replica set (the compose file runs a
 *     single-node rs0, so w:majority costs nothing here)
 */

import { MongoClient, MongoServerError, type Collection, type Db, type Document } from 'mongodb';
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

const DUPLICATE_KEY = 11000;
/** Aggregations over joins sort more than the 100MB in-memory limit. */
const AGG = { allowDiskUse: true };

interface IdDoc extends Document {
  _id: number;
}

const isDup = (err: unknown): boolean =>
  err instanceof MongoServerError && err.code === DUPLICATE_KEY;

function page(docs: Document[], key: (d: Document) => unknown): OpResult {
  const last = docs.length ? Number(key(docs[docs.length - 1]!)) : null;
  return { rows: docs.length, last };
}

const byId = (d: Document): unknown => d._id;
const byPost = (d: Document): unknown => d.p?._id ?? d._id;
const byLike = (d: Document): unknown => d.l?._id ?? d._id;

/** Seed row → document: `id` becomes `_id`. */
function toDoc(r: Row): IdDoc {
  const { id, ...rest } = r;
  return { _id: id as number, ...rest };
}

export class MongoEngine extends Engine {
  readonly name = 'mongodb';
  readonly displayName = 'MongoDB';
  private client: MongoClient | null = null;

  private get db(): Db {
    if (!this.client) throw new Error('mongodb used before connect()');
    return this.client.db(CONNECTIONS.mongodb.database);
  }

  /** Collections keyed by the seed's numeric ids, not ObjectId. */
  private coll(name: string): Collection<IdDoc> {
    return this.db.collection<IdDoc>(name);
  }

  support(_op: OpId, _p: CellParams): string | null {
    return null;
  }

  // ------------------------------------------------------------ lifecycle --

  async connect(): Promise<void> {
    this.client = await MongoClient.connect(CONNECTIONS.mongodb.url, { maxPoolSize: POOL_SIZE });
    await this.db.command({ ping: 1 });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }

  async describe(): Promise<Record<string, string>> {
    const info = await this.db.admin().serverStatus();
    const hello = await this.db.admin().command({ hello: 1 });
    const cache = info.wiredTiger?.cache?.['maximum bytes configured'];
    return {
      version: String(info.version),
      wiredTigerCacheGB: cache ? (Number(cache) / 1024 ** 3).toFixed(2) : 'unknown',
      replicaSet: String(hello.setName ?? 'standalone'),
    };
  }

  async resetSchema(): Promise<void> {
    for (const c of ['users', 'posts', 'likes', 'documents', 'w_plain', 'w_uk', 'w_docs', 'tx_likes']) {
      await this.coll(c).drop().catch(() => {});
    }
    await this.coll('users').createIndex({ email: 1 }, { unique: true });
    await this.coll('w_uk').createIndex({ email: 1 }, { unique: true });
    // tx_likes._id is { u, p }, so a repeated (user, post) pair is a duplicate key.
    await this.db.createCollection('tx_likes');
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    switch (table) {
      case 'users':
        await this.coll('users').insertMany(rows.map(toDoc), { ordered: false });
        break;
      case 'posts':
        await this.coll('posts').insertMany(rows.map(toDoc), { ordered: false });
        break;
      case 'likes':
        await this.coll('likes').insertMany(rows.map(toDoc), { ordered: false });
        break;
      case 'documents':
        // Documents keep their own fields at the top level: { _id, tag, l1: {...}, tags: [...] }.
        await this.coll('documents').insertMany(
          rows.map((r) => ({ _id: r.id as number, ...(r.doc as Document) })), { ordered: false });
        break;
    }
  }

  async afterLoad(): Promise<void> {
    await this.coll('users').createIndex({ created_at: 1 });
    await this.coll('posts').createIndex({ user_id: 1 });
    await this.coll('posts').createIndex({ created_at: 1 });
    await this.coll('likes').createIndex({ post_id: 1 });
    await this.coll('likes').createIndex({ user_id: 1 });
  }

  private nestedField(): string {
    return this.docPath.join('.');
  }

  async createIndex(kind: IndexKind): Promise<void> {
    switch (kind) {
      case 'name-prefix':
        await this.coll('users').createIndex({ name: 1 }, { name: 'name_prefix' });
        break;
      case 'fulltext':
        await this.coll('users').createIndex({ bio: 'text' }, { name: 'bio_text' });
        break;
      case 'json-top':
        await this.coll('documents').createIndex({ tag: 1 }, { name: 'json_top' });
        break;
      case 'json-nested':
        await this.coll('documents').createIndex({ [this.nestedField()]: 1 }, { name: 'json_nested' });
        break;
      case 'json-array':
        await this.coll('documents').createIndex({ tags: 1 }, { name: 'json_array' });
        break;
    }
  }

  async dropIndex(kind: IndexKind): Promise<void> {
    const names: Record<IndexKind, [string, string]> = {
      'name-prefix': ['users', 'name_prefix'],
      fulltext: ['users', 'bio_text'],
      'json-top': ['documents', 'json_top'],
      'json-nested': ['documents', 'json_nested'],
      'json-array': ['documents', 'json_array'],
    };
    const [coll, name] = names[kind];
    await this.coll(coll).dropIndex(name).catch(() => {});
  }

  async truncateScratch(table: ScratchTable): Promise<void> {
    switch (table) {
      case 'w_plain':
        await this.coll('w_plain').deleteMany({});
        break;
      case 'w_uk':
        await this.coll('w_uk').deleteMany({});
        break;
      case 'w_docs':
        await this.coll('w_docs').deleteMany({});
        break;
      case 'tx_likes':
        await this.coll('tx_likes').deleteMany({});
        await this.coll('posts').updateMany({ like_count: { $ne: 0 } }, { $set: { like_count: 0 } });
        break;
    }
  }

  // ---------------------------------------------------------------- reads --

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    const users = this.coll('users');
    const posts = this.coll('posts');
    const likes = this.coll('likes');
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await users.find({}).sort({ _id: 1 }).limit(q.limit).toArray(), byId);
      case 'simple/offset':
        return page(await users.find({}).sort({ _id: 1 }).skip(q.offset).limit(q.limit).toArray(), byId);
      case 'simple/cursor':
        return page(await users.find({ _id: { $gt: q.after } }).sort({ _id: 1 }).limit(q.limit).toArray(), byId);

      case 'single-join/limit':
        return page(await posts.aggregate([
          { $sort: { _id: 1 } },
          { $limit: q.limit },
          { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);
      case 'single-join/offset':
        return page(await posts.aggregate([
          { $sort: { _id: 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
          { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);
      case 'single-join/cursor':
        return page(await posts.aggregate([
          { $match: { _id: { $gt: q.after } } },
          { $sort: { _id: 1 } },
          { $limit: q.limit },
          { $lookup: { from: 'users', localField: 'user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);

      case 'multi-join/limit':
        return page(await likes.aggregate([
          { $sort: { _id: 1 } },
          { $limit: q.limit },
          { $lookup: { from: 'posts', localField: 'post_id', foreignField: '_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'users', localField: 'p.user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);
      case 'multi-join/offset':
        return page(await likes.aggregate([
          { $sort: { _id: 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
          { $lookup: { from: 'posts', localField: 'post_id', foreignField: '_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'users', localField: 'p.user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);
      case 'multi-join/cursor':
        return page(await likes.aggregate([
          { $match: { _id: { $gt: q.after } } },
          { $sort: { _id: 1 } },
          { $limit: q.limit },
          { $lookup: { from: 'posts', localField: 'post_id', foreignField: '_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'users', localField: 'p.user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ], AGG).toArray(), byId);
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    const users = this.coll('users');
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await users.find({ email }).sort({ _id: 1 }).limit(q.limit).toArray(), byId);
      case 'simple/offset':
        return page(await users.find({ email }).sort({ _id: 1 }).skip(q.offset).limit(q.limit).toArray(), byId);
      case 'simple/cursor':
        return page(await users.find({ email, _id: { $gt: q.after } }).sort({ _id: 1 }).limit(q.limit).toArray(), byId);

      case 'single-join/limit':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/offset':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/cursor':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $match: { 'p._id': { $gt: q.after } } },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);

      case 'multi-join/limit':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/offset':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/cursor':
        return page(await users.aggregate([
          { $match: { email } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $match: { 'l._id': { $gt: q.after } } },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    const users = this.coll('users');
    const below = { score: { $lt: cutoff } };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await users.find(below).sort({ _id: 1 }).limit(q.limit).toArray(), byId);
      case 'simple/offset':
        return page(await users.find(below).sort({ _id: 1 }).skip(q.offset).limit(q.limit).toArray(), byId);
      case 'simple/cursor':
        return page(await users.find({ ...below, _id: { $gt: q.after } }).sort({ _id: 1 }).limit(q.limit).toArray(), byId);

      case 'single-join/limit':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/offset':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/cursor':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $match: { 'p._id': { $gt: q.after } } },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);

      case 'multi-join/limit':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/offset':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/cursor':
        return page(await users.aggregate([
          { $match: below },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $match: { 'l._id': { $gt: q.after } } },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    const users = this.coll('users');
    switch (shape) {
      case 'simple':
        return page(await users.find({ _id: id }).toArray(), byId);
      case 'single-join':
        return page(await users.aggregate([
          { $match: { _id: id } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
        ]).toArray(), byPost);
      case 'multi-join':
        return page(await users.aggregate([
          { $match: { _id: id } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
        ]).toArray(), byLike);
    }
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    return page(await this.coll('users').find({ _id: { $in: ids } }).toArray(), byId);
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    const users = this.coll('users');
    const inRange = { created_at: { $gte: from, $lte: to } };
    switch (`${q.shape}/${q.mode}`) {
      case 'simple/limit':
        return page(await users.find(inRange).sort({ _id: 1 }).limit(q.limit).toArray(), byId);
      case 'simple/offset':
        return page(await users.find(inRange).sort({ _id: 1 }).skip(q.offset).limit(q.limit).toArray(), byId);
      case 'simple/cursor':
        return page(await users.find({ ...inRange, _id: { $gt: q.after } }).sort({ _id: 1 }).limit(q.limit).toArray(), byId);

      case 'single-join/limit':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/offset':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $sort: { 'p._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);
      case 'single-join/cursor':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $match: { 'p._id': { $gt: q.after } } },
          { $sort: { 'p._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byPost);

      case 'multi-join/limit':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/offset':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $sort: { 'l._id': 1 } },
          { $skip: q.offset },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/cursor':
        return page(await users.aggregate([
          { $match: inRange },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $match: { 'l._id': { $gt: q.after } } },
          { $sort: { 'l._id': 1 } },
          { $limit: q.limit },
        ], AGG).toArray(), byLike);
    }
    throw new Error(`unreachable: ${q.shape}/${q.mode}`);
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    const db = this.db;
    switch (variant) {
      case 'count-all':
        await db.collection('users').countDocuments({});
        return { rows: 1 };
      case 'count-indexed':
        await db.collection('users').countDocuments({ created_at: { $gte: a.from, $lte: a.to } });
        return { rows: 1 };
      case 'count-unindexed':
        await db.collection('users').countDocuments({ score: { $lt: a.cutoff } });
        return { rows: 1 };
      case 'sum-views':
        return { rows: (await this.coll('posts').aggregate([
          { $group: { _id: null, total: { $sum: '$views' } } },
        ]).toArray()).length };
      case 'posts-per-user':
        return { rows: (await db.collection('users').aggregate([
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $group: { _id: '$_id', posts: { $sum: 1 } } },
        ], AGG).toArray()).length };
      case 'likes-per-post':
        return { rows: (await db.collection('posts').aggregate([
          { $lookup: { from: 'likes', localField: '_id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $group: { _id: '$_id', likes: { $sum: 1 } } },
        ], AGG).toArray()).length };
      case 'likes-per-user':
        return { rows: (await db.collection('users').aggregate([
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $group: { _id: '$_id', likes: { $sum: 1 } } },
        ], AGG).toArray()).length };
    }
  }

  async r8TopN(shape: Shape, key: SortKey, limit: number): Promise<OpResult> {
    const users = this.coll('users');
    switch (`${shape}/${key}`) {
      case 'simple/indexed':
        return page(await users.find({}).sort({ created_at: -1, _id: 1 }).limit(limit).toArray(), byId);
      case 'simple/unindexed':
        return page(await users.find({}).sort({ score: -1, _id: 1 }).limit(limit).toArray(), byId);
      case 'single-join/indexed':
        return page(await users.aggregate([
          { $sort: { created_at: -1, _id: 1 } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $limit: limit },
        ], AGG).toArray(), byPost);
      case 'single-join/unindexed':
        return page(await users.aggregate([
          { $sort: { score: -1, _id: 1 } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $limit: limit },
        ], AGG).toArray(), byPost);
      case 'multi-join/indexed':
        return page(await users.aggregate([
          { $sort: { created_at: -1, _id: 1 } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $limit: limit },
        ], AGG).toArray(), byLike);
      case 'multi-join/unindexed':
        return page(await users.aggregate([
          { $sort: { score: -1, _id: 1 } },
          { $lookup: { from: 'posts', localField: '_id', foreignField: 'user_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: 'likes', localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
          { $limit: limit },
        ], AGG).toArray(), byLike);
    }
    throw new Error(`unreachable: ${shape}/${key}`);
  }

  async r8FullSort(cap: number): Promise<OpResult> {
    return page(await this.coll('users')
      .find({ _id: { $lte: cap } }).sort({ score: 1, _id: 1 }).allowDiskUse(true).toArray(), byId);
  }

  async r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult> {
    const users = this.coll('users');
    switch (pattern) {
      case 'prefix':
        // An anchored, case-sensitive regex is the one form a btree index can serve.
        return page(await users.find({ name: { $regex: `^${term}` } }).limit(limit).toArray(), byId);
      case 'contains':
        return page(await users.find({ name: { $regex: term } }).limit(limit).toArray(), byId);
      case 'suffix':
        return page(await users.find({ name: { $regex: `${term}$` } }).limit(limit).toArray(), byId);
    }
  }

  async r9FullText(term: string, limit: number): Promise<OpResult> {
    return page(await this.coll('users').find({ $text: { $search: term } }).limit(limit).toArray(), byId);
  }

  async r10Json(variant: JsonVariant, value: string, limit: number): Promise<OpResult> {
    const docs = this.coll('documents');
    switch (variant) {
      case 'top-level':
        return page(await docs.find({ tag: value }).limit(limit).toArray(), byId);
      case 'nested':
        return page(await docs.find({ [this.nestedField()]: value }).limit(limit).toArray(), byId);
      case 'array-contains':
        return page(await docs.find({ tags: value }).limit(limit).toArray(), byId);
    }
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.coll('w_plain').insertOne(toDoc(r));
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    try {
      await this.coll('w_uk').insertOne(toDoc(r));
      return { rows: 1 };
    } catch (err) {
      if (isDup(err)) throw new UniqueViolation((err as Error).message);
      throw err;
    }
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    await this.coll('w_plain').insertMany(rows.map(toDoc), { ordered: false });
    return { rows: rows.length };
  }

  async w4InsertDoc(r: Row): Promise<OpResult> {
    await this.coll('w_docs').insertOne({ _id: r.id as number, ...(r.doc as Document) });
    return { rows: 1 };
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(postId: number, userId: number): Promise<LikeOutcome> {
    const session = this.client!.startSession();
    let attempts = 0;
    try {
      // withTransaction retries TransientTransactionError (write conflicts) itself.
      await session.withTransaction(async () => {
        attempts++;
        await this.coll('posts').updateOne({ _id: postId },{ $inc: { like_count: 1 } }, { session });
        await this.coll('tx_likes').insertOne(
          { _id: { u: userId, p: postId } as never, post_id: postId, created_at: new Date() }, { session });
      }, { writeConcern: { w: 'majority' } });
      return { rows: 1, conflict: false, retries: attempts - 1 };
    } catch (err) {
      if (isDup(err)) return { rows: 0, conflict: true, retries: Math.max(0, attempts - 1) };
      throw err;
    } finally {
      await session.endSession();
    }
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    const counted = await this.coll('tx_likes').aggregate<{ _id: number; n: number }>([
      { $group: { _id: '$post_id', n: { $sum: 1 } } },
    ], AGG).toArray();
    const actual = new Map(counted.map((c) => [c._id, c.n]));
    let mismatches = 0;
    const touched = this.coll('posts').find(
      { $or: [{ like_count: { $ne: 0 } }, { _id: { $in: [...actual.keys()] } }] },
      { projection: { like_count: 1 } },
    );
    for await (const p of touched) if (p.like_count !== (actual.get(p._id) ?? 0)) mismatches++;
    const checked = await this.coll('posts').estimatedDocumentCount();
    return { checked, mismatches };
  }
}
