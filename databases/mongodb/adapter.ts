import { MongoClient, type Collection, type Db } from 'mongodb';
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

const DUPLICATE_KEY = 11000;
const WRITE_CONFLICT = 112;

interface UserDoc extends Omit<User, 'id'> { _id: number }
interface PostDoc extends Omit<Post, 'id'> { _id: number }
interface LikeDoc { _id: string; user_id: number; post_id: number; created_at: Date }

function hasTransientLabel(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const labels = (err as { errorLabels?: unknown }).errorLabels;
  return Array.isArray(labels) && labels.includes('TransientTransactionError');
}

function mongoCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'number' ? code : undefined;
}

export function createAdapter(): Adapter {
  // The original mongodb.js called `collection.client.close()`, but `client`
  // is not a property of Collection, so connections were never actually closed.
  // Holding the client is the fix.
  let client: MongoClient | null = null;
  let db: Db | null = null;

  const users = (): Collection<UserDoc> => database().collection<UserDoc>('users');
  const posts = (): Collection<PostDoc> => database().collection<PostDoc>('posts');
  const likes = (): Collection<LikeDoc> => database().collection<LikeDoc>('likes');

  const database = (): Db => {
    if (!db) throw new Error('mongodb adapter used before connect()');
    return db;
  };

  return {
    engine: 'mongodb',
    displayName: 'MongoDB',
    // Verified on Node and Bun. Deno is unsupported repo-wide.
    supportedRuntimes: [Runtime.Node, Runtime.Bun],
    capabilities: {
      // True ACID here, but ONLY because the compose file runs a replica set.
      // Against a standalone mongod this silently degrades to no transaction
      // at all -- which is exactly what verifyCounters() is built to catch.
      transactionality: Transactionality.Acid,
      caseInsensitiveLike: false, // needs an explicit $options: 'i'
    },

    isRetryable: (err) => hasTransientLabel(err) || mongoCode(err) === WRITE_CONFLICT,

    async connect(opts: ConnectOptions) {
      const auth = opts.user ? `${opts.user}:${opts.password}@` : '';
      // directConnection=true is deliberate. With ?replicaSet=rs0 the driver
      // performs topology discovery against whatever hostname the replica set
      // advertises, which for a single-node set in Docker is frequently
      // unreachable from the host and surfaces as a server-selection timeout.
      const uri =
        `mongodb://${auth}${opts.host}:${opts.port}/?directConnection=true` +
        `&maxPoolSize=${opts.poolSize}&serverSelectionTimeoutMS=10000`;

      client = await MongoClient.connect(uri);
      db = client.db(opts.database);

      const hello = await db.admin().command({ hello: 1 });
      if (!hello.setName) {
        throw new Error(
          'MongoDB is running standalone, not as a replica set. Multi-document ' +
            'transactions are unavailable and the like workload cannot be ' +
            'measured honestly. Start it with databases/mongodb/docker-compose.yml.',
        );
      }
    },

    async close() {
      await client?.close();
      client = null;
      db = null;
    },

    async serverVersion() {
      const info = await database().admin().serverInfo();
      return String(info.version ?? 'unknown');
    },

    async memoryConfig() {
      const status = await database().admin().command({ serverStatus: 1 });
      const cacheBytes = status?.wiredTiger?.cache?.['maximum bytes configured'];
      const hello = await database().admin().command({ hello: 1 });
      return {
        wiredTigerCacheGB: cacheBytes
          ? (Number(cacheBytes) / 1024 ** 3).toFixed(2)
          : 'unknown',
        replicaSet: String(hello.setName ?? 'standalone'),
        // On a single-node set, w:majority is satisfied by one node, so Mongo
        // pays no replication cost here. Published so nobody mistakes this for
        // a durable multi-node result.
        writeConcern: JSON.stringify(database().writeConcern ?? { w: 'default' }),
      };
    },

    async resetSchema() {
      await Promise.all([
        likes().drop().catch(() => {}),
        posts().drop().catch(() => {}),
        users().drop().catch(() => {}),
      ]);
      await users().createIndex({ email: 1 }, { unique: true });
      await posts().createIndex({ user_id: 1 });
      await posts().createIndex({ like_count: -1 });
      await likes().createIndex({ post_id: 1 });
      await users().createIndex({ age: 1 });
    },

    async insertUsers(batch: readonly User[]) {
      const docs = batch.map(({ id, ...rest }) => ({ _id: id, ...rest }));
      await users().insertMany(docs, { ordered: false });
    },

    async insertPosts(batch: readonly Post[]) {
      const docs = batch.map(({ id, ...rest }) => ({ _id: id, ...rest }));
      await posts().insertMany(docs, { ordered: false });
    },

    async getUserByEmail(email: string) {
      return users().findOne({ email });
    },

    async listPosts(limit: number) {
      return posts().find().sort({ _id: 1 }).limit(limit).toArray();
    },

    async countUsersByAgeRange(min: number, max: number) {
      return users().countDocuments({ age: { $gte: min, $lte: max } });
    },

    async topPostsByLikes(limit: number) {
      return posts()
        .find({}, { projection: { like_count: 1 } })
        .sort({ like_count: -1, _id: 1 })
        .limit(limit)
        .toArray();
    },

    async likePost(userId: number, postId: number): Promise<TxOutcome> {
      const session = client!.startSession();
      let retries = -1; // withTransaction runs the body at least once
      try {
        // withTransaction, not manual start/commit: it retries the
        // TransientTransactionError and UnknownTransactionCommitResult labels,
        // which WriteConflict (112) raises routinely under hot contention.
        await session.withTransaction(async () => {
          retries++;
          // posts before likes -- same lock order as every other adapter.
          await posts().updateOne(
            { _id: postId },
            { $inc: { like_count: 1 } },
            { session },
          );
          await likes().insertOne(
            { _id: `${userId}:${postId}`, user_id: userId, post_id: postId, created_at: new Date() },
            { session },
          );
        });
        return { retries: Math.max(0, retries), conflict: false };
      } catch (err) {
        if (mongoCode(err) === DUPLICATE_KEY) return { retries: 0, conflict: true };
        throw err;
      } finally {
        await session.endSession();
      }
    },

    async verifyCounters(): Promise<CounterCheck> {
      const [row] = await posts()
        .aggregate([
          {
            $lookup: {
              from: 'likes',
              localField: '_id',
              foreignField: 'post_id',
              as: 'likeDocs',
            },
          },
          {
            $project: {
              drift: { $abs: { $subtract: ['$like_count', { $size: '$likeDocs' }] } },
            },
          },
          {
            $group: {
              _id: null,
              mismatches: { $sum: { $cond: [{ $gt: ['$drift', 0] }, 1, 0] } },
              checked: { $sum: 1 },
              worstDrift: { $max: '$drift' },
            },
          },
        ])
        .toArray();

      return {
        mismatches: Number(row?.mismatches ?? 0),
        postsChecked: Number(row?.checked ?? 0),
        worstDrift: Number(row?.worstDrift ?? 0),
      };
    },
  };
}
