import type { Runtime as Runtimes } from '../core/adapter.ts';

export interface RuntimeGlobals {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
}

export interface HostInfo {
  runtime: Runtime;
  runtimeVersion: string;
  platform: string;
  arch: string;
  cpuModel: string;
  cpuCount: number;
  totalMemoryGB: number;
  osRelease: string;
}

export type Runtime = (typeof Runtimes)[keyof typeof Runtimes];
