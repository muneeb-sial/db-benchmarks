import type { Runtime } from './runtime.type.ts';
import type { SuiteAdapter } from './specs.type.ts';

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
