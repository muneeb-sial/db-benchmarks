/** Response helpers. Every op response carries its DB time as Server-Timing for k6. */

import { HttpError } from './errors.ts';

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A timed op result: `{ ...result, dbMs }` plus `Server-Timing: db;dur=<ms>`. */
export function timed(result: object, dbMs: number, status = 200): Response {
  const ms = Math.round(dbMs * 1000) / 1000;
  return json({ ...result, dbMs: ms }, status, { 'server-timing': `db;dur=${ms}` });
}

export function errorResponse(err: unknown): Response {
  if (err instanceof HttpError) {
    return json({ error: err.code, message: err.message }, err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error(err);
  return json({ error: 'internal', message }, 500);
}
