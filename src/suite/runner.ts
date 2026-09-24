/**
 * Measurement loops for the suite.
 *
 *   runTimed      closed loop for a fixed duration (reads): N workers, each
 *                 running operations back to back, warmup discarded
 *   runFixed      a fixed amount of work split across N workers (writes): every
 *                 attempt is timed, failures included, because a rejected
 *                 insert still costs the database something
 *   runTraversal  every worker walks the whole table page by page, recording
 *                 the latency of each page
 *
 * Operations may return just a row count, or { rows, timeMs } when the timed
 * part is narrower than the whole call (for example a batch insert that must
 * not include the time spent generating its rows).
 */

import { median, summarize } from '../core/stats.ts';
import type { Common, Measure, OpOut, TraversalOut } from '../types/runner.type.ts';

const MAX_SAMPLES = 2_000_000;

const rowsOf = (out: OpOut): number => (typeof out === 'number' ? out : out.rows);
const timeOf = (out: OpOut, fallback: number): number =>
  typeof out === 'object' && out.timeMs !== undefined ? out.timeMs : fallback;
const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runTimed(
  o: Common & {
    durationMs: number;
    warmupMs: number;
    op: (iteration: number, worker: number) => Promise<OpOut>;
  },
): Promise<Measure> {
  const samples = new Float64Array(MAX_SAMPLES);
  let count = 0;
  let rows = 0;
  let errors = 0;
  let uk = 0;
  const sampleErrors = new Set<string>();

  const start = performance.now();
  const measureFrom = start + o.warmupMs;
  const endAt = measureFrom + o.durationMs;

  const worker = async (w: number): Promise<void> => {
    for (let i = 0; performance.now() < endAt; i++) {
      const t0 = performance.now();
      try {
        const out = await o.op(i, w);
        const elapsed = timeOf(out, performance.now() - t0);
        // Warmup samples are discarded: they capture connection setup, cold
        // caches and JIT rather than steady state.
        if (t0 >= measureFrom && count < MAX_SAMPLES) {
          samples[count++] = elapsed;
          rows += rowsOf(out);
        }
      } catch (err) {
        if (t0 >= measureFrom) {
          errors++;
          if (o.isUniqueViolation?.(err)) uk++;
          else if (sampleErrors.size < 5) sampleErrors.add(messageOf(err));
        }
      }
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, (_, w) => worker(w)));

  return {
    ops: count,
    wallMs: Math.max(1, performance.now() - measureFrom),
    rows,
    latency: summarize(samples, count),
    errors,
    ukViolations: uk,
    sampleErrors: [...sampleErrors],
  };
}

export async function runFixed(
  o: Common & { totalOps: number; op: (index: number) => Promise<OpOut> },
): Promise<Measure> {
  const samples = new Float64Array(Math.min(o.totalOps, MAX_SAMPLES));
  let count = 0;
  let next = 0;
  let rows = 0;
  let errors = 0;
  let uk = 0;
  const sampleErrors = new Set<string>();

  const start = performance.now();

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= o.totalOps) return;
      const t0 = performance.now();
      try {
        const out = await o.op(index);
        if (count < samples.length) samples[count++] = timeOf(out, performance.now() - t0);
        rows += rowsOf(out);
      } catch (err) {
        errors++;
        if (count < samples.length) samples[count++] = performance.now() - t0;
        if (o.isUniqueViolation?.(err)) uk++;
        else if (sampleErrors.size < 5) sampleErrors.add(messageOf(err));
      }
    }
  };

  await Promise.all(Array.from({ length: o.concurrency }, () => worker()));

  return {
    ops: o.totalOps,
    wallMs: Math.max(1, performance.now() - start),
    rows,
    latency: summarize(samples, count),
    errors,
    ukViolations: uk,
    sampleErrors: [...sampleErrors],
  };
}

export async function runTraversal(o: {
  concurrency: number;
  walk: (worker: number) => Promise<{ pageMs: number[]; rows: number }>;
}): Promise<TraversalOut> {
  const start = performance.now();
  const runs: Array<{ pageMs: number[]; rows: number }> = [];
  let errors = 0;
  const sampleErrors = new Set<string>();

  await Promise.all(
    Array.from({ length: o.concurrency }, async (_, w) => {
      try {
        runs.push(await o.walk(w));
      } catch (err) {
        errors++;
        if (sampleErrors.size < 5) sampleErrors.add(messageOf(err));
      }
    }),
  );

  const pages = runs.reduce((m, r) => Math.max(m, r.pageMs.length), 0);
  const perPageMs: number[] = [];
  for (let p = 0; p < pages; p++) {
    const at: number[] = [];
    for (const r of runs) {
      const v = r.pageMs[p];
      if (v !== undefined) at.push(v);
    }
    perPageMs.push(median(at));
  }

  return {
    perPageMs,
    totalMs: median(runs.map((r) => r.pageMs.reduce((a, b) => a + b, 0))),
    pages,
    rows: median(runs.map((r) => r.rows)),
    wallMs: Math.max(1, performance.now() - start),
    errors,
    sampleErrors: [...sampleErrors],
    allPageMs: runs.flatMap((r) => r.pageMs),
  };
}
