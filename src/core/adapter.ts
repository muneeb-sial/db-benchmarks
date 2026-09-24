/**
 * The contract every database implements, in its own `databases/<name>/adapter.ts`.
 *
 * `supportedRuntimes` marks where the driver is known to work, because
 * runtimes x databases is not a full grid. The benchmarks themselves live
 * behind `suite` (see src/suite/specs.ts).
 */

import type { SuiteAdapter } from '../suite/specs.ts';

// Deliberately not a TS `enum`: enums are non-erasable and Node's type-stripping
// rejects them outright. This `as const` pattern is the erasable equivalent.
export const Runtime = {
  Node: 'node',
  Bun: 'bun',
} as const;
export type Runtime = (typeof Runtime)[keyof typeof Runtime];

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

  /** The write/read benchmark suite (features.md). */
  readonly suite: SuiteAdapter;

  connect(opts: ConnectOptions): Promise<void>;
  close(): Promise<void>;
  serverVersion(): Promise<string>;

  /**
   * Reported into the results file alongside the numbers. A benchmark that
   * doesn't publish the cache size it ran under isn't reproducible.
   */
  memoryConfig(): Promise<Record<string, string>>;
}
