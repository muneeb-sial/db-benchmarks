/**
 * The headline workload: like a post inside a transaction.
 *
 * Each operation inserts a row into `likes` and increments the denormalized
 * `posts.like_count`. Whether those two writes land together is exactly what
 * `adapter.verifyCounters()` checks afterwards.
 *
 * Contention is the interesting dimension. The same transaction against 700k
 * posts and against 10 posts measures very different things: row-lock queueing
 * on Postgres and MySQL, optimistic-retry storms on CockroachDB, WriteConflict
 * churn on MongoDB.
 */

import type { Adapter, TxOutcome } from '../core/adapter.ts';

export const Contention = {
  /** Likes spread evenly over every post. Measures raw transaction throughput. */
  Uniform: 'uniform',
  /** Likes concentrated on a handful of posts. Measures lock and conflict behaviour. */
  Hot: 'hot',
} as const;
export type Contention = (typeof Contention)[keyof typeof Contention];

export const HOT_POST_COUNT = 10;

export interface LikeWorkloadOptions {
  adapter: Adapter;
  contention: Contention;
  totalUsers: number;
  totalPosts: number;
  concurrency: number;
}

/**
 * Builds the per-operation function handed to the runner.
 *
 * Pair selection is deterministic rather than random, so that no (user, post)
 * pair repeats until the whole space is exhausted. That matters because
 * `likes` has a composite primary key: with random selection against 10 hot
 * posts, duplicate-key conflicts would quickly dominate and we would be timing
 * rejected writes instead of real contention.
 */
export function buildLikeOp(opts: LikeWorkloadOptions) {
  const { adapter, contention, totalUsers, totalPosts, concurrency } = opts;
  const postSpace = contention === Contention.Hot ? HOT_POST_COUNT : totalPosts;

  return (iteration: number, workerId: number): Promise<TxOutcome> => {
    // Interleave workers into one global sequence so they genuinely collide on
    // the same hot posts rather than each walking its own private range.
    const slot = iteration * concurrency + workerId;
    const postId = (slot % postSpace) + 1;
    const userId = (Math.floor(slot / postSpace) % totalUsers) + 1;
    return adapter.likePost(userId, postId);
  };
}
