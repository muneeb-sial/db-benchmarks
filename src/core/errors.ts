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
