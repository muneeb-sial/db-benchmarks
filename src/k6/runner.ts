/**
 * POST /api/k6?script=r1&DB=postgres&VUS=8&SHAPE=simple&...
 *
 * Spawns k6 against this server and streams its output back as plain text,
 * so the UI can show a run live. Closing the request kills the k6 process.
 * Only scripts in k6/ and upper-case env names are accepted.
 */

import { resolve } from 'node:path';
import { PATHS } from '../config/paths.ts';
import { BadParams, HttpError } from '../http/errors.ts';
import { findK6, K6_MISSING } from './path.ts';
import { getQuery } from '../http/params.ts';

const SCRIPTS = new Set(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7', 'r8', 'r9', 'r10', 'w1', 'w2', 'w3', 'w4', 'like']);
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const ENV_VALUE = /^[\w.@:/-]*$/;

export function runK6(req: Request, baseUrl: string): Response {
  const k6 = findK6();
  if (!k6) throw new HttpError(501, K6_MISSING, 'no_k6');
  const { script, ...env } = getQuery(req);
  if (!script || !SCRIPTS.has(script)) throw new BadParams(`script must be one of: ${[...SCRIPTS].join(', ')}`);
  if (!env.DB) throw new BadParams('missing DB');

  const args = [k6, 'run', '--no-color', '-e', `BASE_URL=${baseUrl}`];
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_NAME.test(k) || !ENV_VALUE.test(v) || k === 'BASE_URL' || k === 'OUT') throw new BadParams(`bad env ${k}`);
    args.push('-e', `${k}=${v}`);
  }
  args.push(resolve(PATHS.k6, `${script}.js`));

  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  req.signal.addEventListener('abort', () => proc.kill());

  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode(`$ k6 run ${args.slice(2).join(' ')}\n\n`));
      const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
        for await (const chunk of stream) controller.enqueue(chunk);
      };
      await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
      const code = await proc.exited;
      controller.enqueue(encoder.encode(`\n[k6 exited with code ${code}]\n`));
      controller.close();
    },
    cancel() {
      proc.kill();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-cache' } });
}
