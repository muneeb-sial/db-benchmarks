import type { Adapter } from './adapter.type.ts';
import type { SuiteConfig } from './config.type.ts';

export interface SuiteRunOptions {
  adapter: Adapter;
  cfg: SuiteConfig;
  /** Test ids to run; null means all. */
  selection: Set<string> | null;
  log: (line: string) => void;
}
