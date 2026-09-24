import type { SuiteEngineResult } from './results.type.ts';
import type { HostInfo } from './runtime.type.ts';

export interface EngineResult {
  engine: string;
  displayName: string;
  serverVersion: string;
  memoryConfig: Record<string, string>;
  /** Results of the write/read benchmark suite (features.md), when it ran. */
  suite?: SuiteEngineResult;
  skipped?: string;
}

export interface BenchmarkRun {
  runId: string;
  startedAt: string;
  host: HostInfo;
  config: Record<string, unknown>;
  engines: EngineResult[];
}
