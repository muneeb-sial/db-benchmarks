/** Read workloads: indexed point lookup, range scan, aggregate, and a sorted top-N. */

import type { Adapter, User } from '../core/adapter.ts';

export const ReadWorkload = {
  /** Indexed equality lookup on a unique column. */
  PointLookup: 'point-lookup',
  /** Unindexed range predicate over an int column. */
  AgeRange: 'age-range',
  /** Bounded scan returning whole rows -- dominated by serialization cost. */
  ListPosts: 'list-posts',
  /** Sort by the denormalized counter. The reason like_count exists at all. */
  TopPosts: 'top-posts',
} as const;
export type ReadWorkload = (typeof ReadWorkload)[keyof typeof ReadWorkload];

export interface ReadWorkloadOptions {
  adapter: Adapter;
  workload: ReadWorkload;
  users: readonly User[];
  concurrency: number;
  limit: number;
}

const AGE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [15, 20],
  [21, 25],
  [26, 30],
  [31, 35],
];

export function buildReadOp(opts: ReadWorkloadOptions) {
  const { adapter, workload, users, concurrency, limit } = opts;

  return async (iteration: number, workerId: number): Promise<void> => {
    const slot = iteration * concurrency + workerId;

    switch (workload) {
      case ReadWorkload.PointLookup: {
        // Walk the whole email space rather than hammering one row, so this
        // measures index lookups instead of a single cached buffer page.
        const user = users[slot % users.length]!;
        await adapter.getUserByEmail(user.email);
        return;
      }
      case ReadWorkload.AgeRange: {
        const [min, max] = AGE_RANGES[slot % AGE_RANGES.length]!;
        await adapter.countUsersByAgeRange(min, max);
        return;
      }
      case ReadWorkload.ListPosts: {
        await adapter.listPosts(limit);
        return;
      }
      case ReadWorkload.TopPosts: {
        await adapter.topPostsByLikes(limit);
        return;
      }
    }
  };
}
