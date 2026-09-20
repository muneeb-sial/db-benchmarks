/**
 * The contract every database implements, in its own `databases/<name>/adapter.ts`.
 *
 * Two fields exist specifically to stop dishonest comparisons:
 *   - `transactionality` marks what an engine's "transaction" actually guarantees.
 *   - `supportedRuntimes` marks where the driver is known to work, because
 *     runtimes x databases is not a full grid.
 */

import type { SuiteAdapter } from '../suite/specs.ts';

// Deliberately not a TS `enum`: enums are non-erasable and Node's type-stripping
// rejects them outright. This `as const` pattern is the erasable equivalent.
export const Runtime = {
  Node: 'node',
  Bun: 'bun',
} as const;
export type Runtime = (typeof Runtime)[keyof typeof Runtime];

export const Transactionality = {
  /** Real multi-statement ACID. Postgres, MySQL, CockroachDB, Mongo on a replica set. */
  Acid: 'acid',
  /** All-or-nothing eventually, but no isolation and no rollback. A Cassandra logged BATCH. */
  AtomicNotIsolated: 'atomic-not-isolated',
  /** No grouping at all. The counter and the row can diverge. */
  None: 'none',
} as const;
export type Transactionality = (typeof Transactionality)[keyof typeof Transactionality];

export interface Capabilities {
  transactionality: Transactionality;
  /** Whether a LIKE/regex name filter is case-insensitive without extra work. */
  caseInsensitiveLike: boolean;
  /**
   * Workload names (`like-tx`, `top-posts`, ...) this engine cannot run
   * honestly. The harness skips them and records that in the results instead of
   * benchmarking a fake. Cassandra lists `like-tx`: it has no cross-partition
   * transaction, so the like-plus-counter operation this benchmark is built
   * around cannot be expressed atomically there.
   */
  unsupportedWorkloads: readonly string[];
}

export interface User {
  id: number;
  first_name: string;
  last_name: string;
  email: string;
  password: string;
  age: number;
  gender: string;
  created_at: Date;
  updated_at: Date;
}

export interface Post {
  id: number;
  user_id: number;
  title: string;
  body: string;
  like_count: number;
  created_at: Date;
  updated_at: Date;
}

export interface TxOutcome {
  /** How many times the engine made us re-run the transaction before it committed. */
  retries: number;
  /** True when the (user, post) pair already existed, so nothing was written. */
  conflict: boolean;
}

export interface CounterCheck {
  /** Posts whose stored like_count disagrees with an actual count of their likes. */
  mismatches: number;
  postsChecked: number;
  /** Largest absolute drift found, useful for telling "off by one" from "torn". */
  worstDrift: number;
}

export interface ConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  poolSize: number;
}

export interface Adapter {
  readonly engine: string;
  readonly displayName: string;
  readonly supportedRuntimes: readonly Runtime[];
  readonly capabilities: Capabilities;

  /**
   * The write/read benchmark suite (features.md). Optional so an engine can be
   * added for like-tx first and grow into the suite later.
   */
  readonly suite?: SuiteAdapter;

  connect(opts: ConnectOptions): Promise<void>;
  close(): Promise<void>;
  serverVersion(): Promise<string>;

  /**
   * Reported into the results file alongside the numbers. A benchmark that
   * doesn't publish the cache size it ran under isn't reproducible.
   */
  memoryConfig(): Promise<Record<string, string>>;

  /** Drop and recreate users/posts/likes plus indexes. Must be idempotent. */
  resetSchema(): Promise<void>;

  insertUsers(batch: readonly User[]): Promise<void>;
  insertPosts(batch: readonly Post[]): Promise<void>;

  // --- measured read operations ---
  getUserByEmail(email: string): Promise<unknown>;
  // readonly, because postgres.js hands back an immutable RowList rather than
  // a plain array. Nothing here mutates results, so widening beats casting.
  listPosts(limit: number): Promise<readonly unknown[]>;
  countUsersByAgeRange(min: number, max: number): Promise<number>;
  topPostsByLikes(limit: number): Promise<readonly unknown[]>;

  // --- the headline operation ---
  /**
   * Insert a like AND increment posts.like_count, atomically. Engines that list
   * `like-tx` in `unsupportedWorkloads` never have this called.
   */
  likePost(userId: number, postId: number): Promise<TxOutcome>;

  /**
   * The integrity check the whole benchmark hangs on. Compares every stored
   * like_count against a real count of that post's likes. An engine that was
   * fast because its transaction didn't hold fails here.
   */
  verifyCounters(): Promise<CounterCheck>;

  /** Classifies driver errors the shared retry helper should retry. */
  isRetryable(err: unknown): boolean;
}
