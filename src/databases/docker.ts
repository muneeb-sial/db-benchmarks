/**
 * Gives a database a fresh container before it is initialized:
 *
 *   docker compose down -v --remove-orphans   container and any volumes gone, so no old data
 *   docker compose up -d --wait               new container, blocks until its healthcheck passes
 *
 * run from src/databases/<db>/, then connect again. Every initialize starts from
 * an empty engine, never from whatever a previous run left behind.
 */

import { resolve } from 'node:path';
import { PATHS } from '../config/paths.ts';
import type { Engine } from '../engine/engine.ts';
import { HttpError } from '../http/errors.ts';
import { closeEngine, engineFor } from '../engines/registry.ts';

export interface Recreated {
  engine: Engine;
  downMs: number;
  upMs: number;
  composeOutput: string;
}

/** After `--wait` the container is healthy, but a driver can still race the listener for a moment. */
const CONNECT_RETRIES = 15;
const RETRY_DELAY_MS = 2000;
const COMPOSE_TIMEOUT_MS = 10 * 60_000;

/** Connection-refused errors often carry only a code (or are AggregateErrors with an empty message). */
function message(err: unknown): string {
  const e = err as { message?: string; code?: string; errors?: unknown[] };
  if (e?.message) return e.message;
  if (e?.errors?.length) return e.errors.map(message).join('; ');
  return e?.code ?? String(err);
}

async function compose(docker: string, dir: string, args: string[]): Promise<{ ms: number; output: string }> {
  const t0 = performance.now();
  const proc = Bun.spawn([docker, 'compose', ...args], { cwd: dir, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => proc.kill(), COMPOSE_TIMEOUT_MS);
  const [out, errOut, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  const output = `$ docker compose ${args.join(' ')}\n${out}${errOut}`.trim();
  if (code !== 0) {
    // Typically Docker Desktop not running, a port already taken, or the healthcheck timing out.
    throw new HttpError(503, `docker compose ${args[0]} failed (exit ${code}):\n${output}`, 'compose_failed');
  }
  return { ms: Math.round(performance.now() - t0), output };
}

export async function recreate(db: string, log: (s: string) => void = console.log): Promise<Recreated> {
  const dir = resolve(PATHS.databases, db);
  if (!(await Bun.file(resolve(dir, 'docker-compose.yml')).exists())) {
    throw new HttpError(503, `no ${dir}/docker-compose.yml to create ${db} from`, 'no_compose');
  }
  const docker = Bun.which('docker');
  if (!docker) throw new HttpError(503, 'docker is not on PATH', 'no_docker');

  // Drop our pool first, so the old container isn't torn down under open connections.
  await closeEngine(db);

  log(`  ${db}: removing the old container and its data`);
  const down = await compose(docker, dir, ['down', '-v', '--remove-orphans']);
  log(`  ${db}: starting a fresh container`);
  const up = await compose(docker, dir, ['up', '-d', '--wait']);
  log(`  ${db}: container healthy (down ${down.ms}ms, up ${up.ms}ms)`);

  let lastErr: unknown;
  for (let attempt = 1; attempt <= CONNECT_RETRIES; attempt++) {
    try {
      const engine = await engineFor(db);
      return { engine, downMs: down.ms, upMs: up.ms, composeOutput: `${down.output}\n\n${up.output}` };
    } catch (err) {
      lastErr = err;
      await Bun.sleep(RETRY_DELAY_MS);
    }
  }
  throw new HttpError(503, `${db} container is up but connecting still fails: ${message(lastErr)}`, 'db_down');
}
