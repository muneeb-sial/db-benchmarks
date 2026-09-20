/**
 * Closed-loop load generator.
 *
 * Exactly `concurrency` workers each run operations sequentially until a
 * deadline. That holds in-flight work genuinely fixed, unlike
 * `Promise.all(rows.map(op))`, which queues thousands of operations against a
 * small pool and then reports the drain time as if it were latency.
 *
 * Known limitation, documented rather than hidden: a closed loop understates
 * latency under overload, because a stalled worker stops issuing new work
 * (coordinated omission). It is the right trade for comparing engines against
 * each other; it means these numbers are comparative, not absolute.
 */

import { summarize, type Summary } from './stats.ts';
import type { TxOutcome } from './adapter.ts';

export interface RunnerOptions {
  concurrency: number;
  durationMs: number;
  warmupMs: number;
  /** Receives a monotonically increasing per-worker op index. */
  op: (iteration: number, workerId: number) => Promise<TxOutcome | void>;
}

export interface RunResult {
  concurrency: number;
  durationMs: number;
  throughputPerSec: number;
  latencyMs: Summary;
  errors: number;
  retries: number;
  conflicts: number;
  /** First few distinct error messages, so a failed run is diagnosable. */
  sampleErrors: string[];
}

const MAX_SAMPLES = 2_000_000;

export async function runClosedLoop(opts: RunnerOptions): Promise<RunResult> {
  const { concurrency, durationMs, warmupMs, op } = opts;

  const samples = new Float64Array(MAX_SAMPLES);
  let sampleCount = 0;
  let errors = 0;
  let retries = 0;
  let conflicts = 0;
  const sampleErrors = new Set<string>();

  const startedAt = performance.now();
  const measureFrom = startedAt + warmupMs;
  const endAt = measureFrom + durationMs;

  const worker = async (workerId: number): Promise<void> => {
    for (let i = 0; performance.now() < endAt; i++) {
      const t0 = performance.now();
      try {
        const outcome = await op(i, workerId);
        const elapsed = performance.now() - t0;

        // Warmup samples are discarded: they capture connection establishment,
        // cold caches and JIT warmup rather than steady-state behaviour.
        if (t0 >= measureFrom && sampleCount < MAX_SAMPLES) {
          samples[sampleCount++] = elapsed;
          if (outcome) {
            retries += outcome.retries;
            if (outcome.conflict) conflicts++;
          }
        }
      } catch (err) {
        if (t0 >= measureFrom) {
          errors++;
          if (sampleErrors.size < 5) {
            sampleErrors.add(err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));

  const actualMs = performance.now() - measureFrom;

  return {
    concurrency,
    durationMs: Math.round(actualMs),
    throughputPerSec: actualMs > 0 ? (sampleCount / actualMs) * 1000 : 0,
    latencyMs: summarize(samples, sampleCount),
    errors,
    retries,
    conflicts,
    sampleErrors: [...sampleErrors],
  };
}
