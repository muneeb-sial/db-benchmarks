/**
 * Shared bounded retry with exponential backoff and jitter.
 *
 * This is core infrastructure rather than a helper because contention is the
 * point of the benchmark. CockroachDB aborts on 40001 by design, InnoDB kills
 * one side of a deadlock on 1213, and SQL Server raises 1205 -- a harness that
 * silently swallowed those would report a throughput number that no longer
 * corresponds to committed work.
 *
 * Retries are counted and returned so they can be published as a metric.
 */

export interface RetryOptions {
  isRetryable: (err: unknown) => boolean;
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

export interface RetryResult<T> {
  value: T;
  retries: number;
}

export class RetryExhaustedError extends Error {
  readonly attempts: number;
  override readonly cause: unknown;

  constructor(attempts: number, cause: unknown) {
    super(`transaction still failing after ${attempts} attempts`);
    this.name = 'RetryExhaustedError';
    this.attempts = attempts;
    this.cause = cause;
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions,
): Promise<RetryResult<T>> {
  const maxAttempts = opts.maxAttempts ?? 10;
  const baseDelayMs = opts.baseDelayMs ?? 1;
  const maxDelayMs = opts.maxDelayMs ?? 250;

  let retries = 0;

  for (let attempt = 1; ; attempt++) {
    try {
      return { value: await fn(), retries };
    } catch (err) {
      if (attempt >= maxAttempts || !opts.isRetryable(err)) {
        if (attempt >= maxAttempts && opts.isRetryable(err)) {
          throw new RetryExhaustedError(attempt, err);
        }
        throw err;
      }
      retries++;
      // Full jitter. Without it, every contending worker backs off in lockstep
      // and re-collides, which turns a retry into a thundering herd.
      const ceiling = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(Math.random() * ceiling);
    }
  }
}

/** Pulls a driver error code out of the various shapes drivers use. */
export function errorCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const e = err as { code?: unknown; errno?: unknown; number?: unknown };
  if (typeof e.code === 'string') return e.code;
  if (typeof e.code === 'number') return String(e.code);
  if (typeof e.errno === 'number') return String(e.errno);
  if (typeof e.number === 'number') return String(e.number);
  return undefined;
}
