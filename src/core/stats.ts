import type { Summary } from '../types/stats.type.ts';

/** Sorts `samples` in place. Caller must not rely on the original order. */
export function summarize(samples: Float64Array, count: number): Summary {
  if (count === 0) {
    return { count: 0, min: 0, mean: 0, p50: 0, p95: 0, p99: 0, max: 0, stddev: 0 };
  }

  const used = samples.subarray(0, count);
  used.sort();

  let sum = 0;
  for (let i = 0; i < count; i++) sum += used[i]!;
  const mean = sum / count;

  let variance = 0;
  for (let i = 0; i < count; i++) {
    const d = used[i]! - mean;
    variance += d * d;
  }

  return {
    count,
    min: used[0]!,
    mean,
    p50: percentile(used, 0.5),
    p95: percentile(used, 0.95),
    p99: percentile(used, 0.99),
    max: used[count - 1]!,
    stddev: Math.sqrt(variance / count),
  };
}

/** Nearest-rank percentile over an already-sorted array. */
function percentile(sorted: Float64Array, q: number): number {
  const rank = Math.ceil(q * sorted.length);
  const idx = Math.min(sorted.length - 1, Math.max(0, rank - 1));
  return sorted[idx]!;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 0 ? (s[mid - 1]! + s[mid]!) / 2 : s[mid]!;
}
