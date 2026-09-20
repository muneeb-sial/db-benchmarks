/** Runtime detection and host fingerprinting for Node and Bun. Deno is deliberately unsupported. */

import os from 'node:os';
import process from 'node:process';
import { Runtime } from './adapter.ts';

interface RuntimeGlobals {
  Deno?: { version?: { deno?: string } };
  Bun?: { version?: string };
}

/** Deno exposes a Node-compat `process` shim, so it would otherwise be misdetected as Node. */
export function isDeno(): boolean {
  return typeof (globalThis as RuntimeGlobals).Deno?.version?.deno === 'string';
}

/**
 * Fails fast instead of half-running. Deno is unsupported: several of the
 * drivers here (mongodb, mysql2) have documented node-compat failures on it,
 * and it is not part of the verified matrix.
 */
export function assertSupportedRuntime(): void {
  if (isDeno()) {
    console.error('db-benchmarks does not support Deno. Run it with Bun (bun src/cli.ts) or Node >= 22.18.');
    process.exit(1);
  }
}

export function detectRuntime(): Runtime {
  return typeof (globalThis as RuntimeGlobals).Bun?.version === 'string' ? Runtime.Bun : Runtime.Node;
}

export function runtimeVersion(): string {
  const g = globalThis as RuntimeGlobals;
  return g.Bun?.version ?? process.version;
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

/**
 * Everything here comes from node:os, which is available on both runtimes
 * without spawning anything.
 *
 * Deliberately NOT using `systeminformation`, which the previous version of
 * this repo relied on. It shells out to system binaries and it collects hardware serial numbers, machine UUIDs and the
 * fully-qualified hostname. Those ended up committed in the old results files.
 * Benchmarks now run on personal hardware rather than a throwaway CI runner,
 * and results are meant to be shared, so the fingerprint below is limited to
 * what actually explains a performance number.
 */
export function hostInfo(): HostInfo {
  const cpus = os.cpus();
  return {
    runtime: detectRuntime(),
    runtimeVersion: runtimeVersion(),
    platform: os.platform(),
    arch: os.arch(),
    cpuModel: cpus[0]?.model ?? 'unknown',
    cpuCount: cpus.length,
    totalMemoryGB: Number((os.totalmem() / 1024 ** 3).toFixed(2)),
    osRelease: os.release(),
  };
}
