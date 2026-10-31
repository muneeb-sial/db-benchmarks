/**
 * Runs a suite: for each database, a fresh container and seed (optional), then
 * one k6 process per cell per concurrency level, against this server. Every
 * step is reported through `emit`, which POST /api/suite streams as NDJSON.
 *
 * Results land in results/<run-id>/: one k6 summary JSON per run, plus
 * run.json (request + resolved config), outcomes.json and summary.md.
 */

import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { loadConfig, type ServerConfig } from '../config/config.ts';
import { PATHS } from '../config/paths.ts';
import { BadParams, HttpError } from '../http/errors.ts';
import { findK6, K6_MISSING } from '../k6/path.ts';
import { coverage } from '../http/ops.ts';
import { readManifest } from '../seed/manifest.ts';
import type { Engine } from '../engine/engine.ts';
import { DATABASES, engineFor, engineInfo } from '../engines/registry.ts';
import { dbState, initialize, ready, setIndex } from '../databases/state.ts';
import type { Compact, PlanEvent, SuiteEvent } from './events.ts';
import { ALL_TESTS, buildCells, type Cell } from './matrix.ts';

export interface SuiteRequest {
  dbs: string[];
  /** Test ids; omitted or empty means all. */
  tests?: string[];
  /** Recreate each database's container and load the seed first (default true). */
  initialize?: boolean;
  /** With initialize: also build every supported search index (default true). */
  indexes?: boolean;
  /** Also stream raw k6 output. */
  verbose?: boolean;
  /** Same shape as bench.config.json, merged over the server's profile. `dataset` is not allowed. */
  overrides?: Record<string, unknown>;
}

interface DbPlan {
  db: string;
  runnable: Cell[];
  na: { cell: Cell; reason: string }[];
}

export interface PreparedSuite {
  req: SuiteRequest;
  cfg: ServerConfig;
  dbs: DbPlan[];
  plan: PlanEvent;
}

interface Outcome {
  db: string;
  cell: string;
  vus?: number;
  status: 'ok' | 'na' | 'failed';
  reason?: string;
  compact?: Compact;
}

const TAIL_LINES = 15;

/**
 * Keys a suite request may override. They shape the matrix or what k6 is told.
 * Everything else is read by the server from its own profile (the R3 cutoff,
 * R7 range, R8 sort cap, R10 doc shape) or comes from the seed (dataset).
 */
const OVERRIDABLE = ['concurrency', 'limits', 'shapes', 'readModes', 'run', 'writes', 'reads'];
const OVERRIDABLE_READS = ['r4', 'r5'];

/** The per-run settings the UI pre-fills its advanced box with (the form owns the matrix keys). */
export function editableDefaults(cfg: ServerConfig): Record<string, unknown> {
  return { writes: cfg.writes, reads: { r4: cfg.reads.r4, r5: cfg.reads.r5 } };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates the request and works out every cell, without touching a database. */
export async function prepareSuite(body: unknown, base: ServerConfig): Promise<PreparedSuite> {
  if (!isObj(body)) throw new BadParams('body must be a JSON object');
  const req = body as unknown as SuiteRequest;
  if (!Array.isArray(req.dbs) || req.dbs.length === 0) throw new BadParams('dbs must be a non-empty list');
  for (const db of req.dbs) if (!DATABASES.includes(db)) throw new BadParams(`unknown database "${db}"; known: ${DATABASES.join(', ')}`);
  const tests = new Set(req.tests?.length ? req.tests : ALL_TESTS);
  for (const t of tests) if (!(ALL_TESTS as readonly string[]).includes(t)) throw new BadParams(`unknown test "${t}"`);

  const overrides = req.overrides ?? {};
  if (!isObj(overrides)) throw new BadParams('overrides must be an object');
  if ('dataset' in overrides) throw new BadParams('overrides.dataset is not allowed: dataset sizes come from the seed; regenerate it instead');
  for (const key of Object.keys(overrides)) {
    if (!OVERRIDABLE.includes(key)) {
      throw new BadParams(`overrides.${key} is not a per-run setting; overridable: ${OVERRIDABLE.join(', ')}`);
    }
  }
  if (isObj(overrides.reads)) {
    for (const key of Object.keys(overrides.reads)) {
      if (!OVERRIDABLE_READS.includes(key)) {
        throw new BadParams(
          `overrides.reads.${key} is read by the server itself, so a per-run override would not take effect; ` +
            `change it in bench.config.json and restart the server (per-run: reads.${OVERRIDABLE_READS.join(', reads.')})`,
        );
      }
    }
  }

  let cfg: ServerConfig;
  try {
    cfg = await loadConfig(base.profile, overrides);
  } catch (err) {
    throw new BadParams((err as Error).message);
  }
  const manifest = await readManifest(base);
  const cells = buildCells(cfg, tests, manifest.limits);

  const dbs: DbPlan[] = [];
  for (const db of req.dbs) {
    const cov = coverage(await engineInfo(db));
    const p: DbPlan = { db, runnable: [], na: [] };
    for (const cell of cells) {
      const reason = cell.coverage.map((k) => cov[k]).find((v) => v && v !== 'ok');
      if (reason) p.na.push({ cell, reason });
      else p.runnable.push(cell);
    }
    dbs.push(p);
  }

  const levels = cfg.concurrency.length;
  const runs = dbs.reduce((a, d) => a + d.runnable.length * levels, 0);
  const timedSec = dbs.reduce(
    (a, d) => a + d.runnable.filter((c) => c.timed).length * levels * (cfg.run.durationSec + cfg.run.warmupSec), 0);
  const plan: PlanEvent = {
    type: 'plan',
    runId: new Date().toISOString().replace(/[:.]/g, '-'),
    profile: cfg.profile,
    dbs: dbs.map((d) => ({ db: d.db, cells: d.runnable.length + d.na.length, na: d.na.length, runs: d.runnable.length * levels })),
    runs,
    timedMinutes: timedSec / 60,
  };
  return { req, cfg, dbs, plan };
}

let running = false;

export async function runSuite(
  s: PreparedSuite,
  base: ServerConfig,
  baseUrl: string,
  emit: (e: SuiteEvent) => void,
  signal: AbortSignal,
): Promise<void> {
  if (running) throw new HttpError(409, 'a suite is already running', 'busy');
  const k6 = findK6();
  if (!k6) throw new HttpError(501, K6_MISSING, 'no_k6');
  running = true;

  const { cfg, plan } = s;
  const dir = resolve(PATHS.results, plan.runId);
  const outcomes: Outcome[] = [];
  let index = 0;

  try {
    await mkdir(dir, { recursive: true });
    await Bun.write(resolve(dir, 'run.json'), JSON.stringify({ request: s.req, config: cfg }, null, 2));
    emit(plan);

    for (const d of s.dbs) {
      if (signal.aborted) break;
      const init = s.req.initialize !== false;
      // k6 writes its summaries here, so it must exist even when nothing else writes to it (no initialize).
      await mkdir(resolve(dir, d.db), { recursive: true });
      emit({ type: 'db-start', db: d.db, initialize: init });
      try {
        if (init) {
          const r = await initialize(d.db, base, (text) => emit({ type: 'log', text }), { indexes: s.req.indexes !== false });
          await Bun.write(resolve(dir, d.db, 'initialize.json'), JSON.stringify(r, null, 2));
          emit({
            type: 'db-ready', db: d.db, downMs: r.container.downMs, upMs: r.container.upMs, loadMs: r.loadMs, indexMs: r.indexMs,
          });
        } else {
          if (!dbState(d.db)) throw new Error(`${d.db} is not initialized; run with initialize on`);
          emit({ type: 'db-ready', db: d.db });
        }
      } catch (err) {
        emit({ type: 'db-failed', db: d.db, message: (err as Error).message });
        index += d.runnable.length * cfg.concurrency.length;
        continue;
      }

      for (const { cell, reason } of d.na) {
        outcomes.push({ db: d.db, cell: cell.label, status: 'na', reason });
        emit({ type: 'cell-na', db: d.db, cell: cell.label, reason });
      }

      // Search indexes the database has now; whatever a no-index cell drops is rebuilt before we leave it.
      const engine = await engineFor(d.db);
      const before = [...ready(d.db).indexes];
      try {
        for (const cell of d.runnable) {
          if (signal.aborted) break;
          let indexError: string | null = null;
          try {
            await applyIndexes(d.db, engine, cell, emit);
          } catch (err) {
            indexError = `could not set up indexes: ${(err as Error).message}`;
          }
          for (const vus of cfg.concurrency) {
            if (signal.aborted) break;
            index++;
            const ev = { db: d.db, cell: cell.label, vus, index, total: plan.runs };
            emit({ type: 'cell-start', ...ev });
            const r = indexError
              ? { reason: indexError, tail: '' }
              : await runCell(k6, cell, d.db, vus, cfg, baseUrl, dir, s.req.verbose === true, emit, signal);
            if (r.compact) {
              outcomes.push({ db: d.db, cell: cell.label, vus, status: 'ok', compact: r.compact });
              emit({ type: 'cell-result', ...ev, compact: r.compact });
            } else {
              outcomes.push({ db: d.db, cell: cell.label, vus, status: 'failed', reason: r.reason });
              emit({ type: 'cell-failed', ...ev, reason: r.reason, tail: r.tail });
            }
          }
        }
      } finally {
        // Leave the database with the indexes it had before the suite, even after Stop or a failure.
        for (const kind of before) {
          try {
            const ms = await setIndex(d.db, engine, kind, true);
            if (ms !== null) emit({ type: 'log', text: `  index: rebuilt ${kind} (${Math.round(ms)} ms), restoring the database's indexes` });
          } catch (err) {
            emit({ type: 'log', text: `  index: could not rebuild ${kind}: ${(err as Error).message}` });
          }
        }
      }
    }
  } finally {
    running = false;
    await writeSummary(dir, plan, cfg, s.dbs.map((d) => d.db), outcomes).catch(() => {});
    emit({
      type: 'done',
      runId: plan.runId,
      dir,
      ok: outcomes.filter((o) => o.status === 'ok').length,
      na: outcomes.filter((o) => o.status === 'na').length,
      failed: outcomes.filter((o) => o.status === 'failed').length,
      aborted: signal.aborted,
    });
  }
}

/** Drops what the cell must run without, builds what it must run with; reports each change. */
async function applyIndexes(db: string, engine: Engine, cell: Cell, emit: (e: SuiteEvent) => void): Promise<void> {
  for (const kind of cell.noIndex) {
    const ms = await setIndex(db, engine, kind, false);
    if (ms !== null) emit({ type: 'log', text: `  index: dropped ${kind} (${Math.round(ms)} ms) for the no-index cells` });
  }
  for (const kind of cell.needIndex) {
    const ms = await setIndex(db, engine, kind, true);
    if (ms !== null) emit({ type: 'log', text: `  index: built ${kind} (${Math.round(ms)} ms)` });
  }
}

async function runCell(
  k6: string,
  cell: Cell,
  db: string,
  vus: number,
  cfg: ServerConfig,
  baseUrl: string,
  dir: string,
  verbose: boolean,
  emit: (e: SuiteEvent) => void,
  signal: AbortSignal,
): Promise<{ compact?: Compact; reason: string; tail: string }> {
  const file = resolve(dir, db, `${cell.label.replace(/[^\w+-]+/g, '_')}@${vus}.json`);
  const env: Record<string, string | number> = {
    DB: db, BASE_URL: baseUrl, VUS: vus, DURATION: cfg.run.durationSec, WARMUP: cfg.run.warmupSec, OUT: file, ...cell.env,
  };
  const args = [k6, 'run', '--no-color', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    resolve(PATHS.k6, cell.script)];

  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const kill = (): void => proc.kill();
  signal.addEventListener('abort', kill);

  // Keep the last lines for a failure report; stream everything when verbose.
  const tail: string[] = [];
  const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      rest += decoder.decode(chunk, { stream: true });
      const lines = rest.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        tail.push(line);
        if (tail.length > TAIL_LINES) tail.shift();
        if (verbose) emit({ type: 'k6', text: line });
      }
    }
    if (rest) tail.push(rest);
  };
  await Promise.all([pump(proc.stdout), pump(proc.stderr)]);
  const code = await proc.exited;
  signal.removeEventListener('abort', kill);

  if (signal.aborted) return { reason: 'stopped', tail: '' };
  const summary = Bun.file(file);
  if (code !== 0 || !(await summary.exists())) {
    return { reason: `k6 exited ${code}`, tail: tail.filter((l) => l.trim()).map((l) => `    ${l}`).join('\n') };
  }
  const { compact } = (await summary.json()) as { compact: Compact };
  return { compact, reason: '', tail: '' };
}

async function writeSummary(dir: string, plan: PlanEvent, cfg: ServerConfig, dbs: string[], outcomes: Outcome[]): Promise<void> {
  const fmt = (v: number | undefined): string => (v === undefined ? '' : String(Math.round(v * 100) / 100));
  const lines: string[] = [`# Run ${plan.runId}`, '', `Profile \`${cfg.profile}\`, concurrency ${cfg.concurrency.join(', ')}.`, ''];
  lines.push('Latency in ms. `http` is end to end as k6 saw it; `db` is the server-side time of the database call alone.', '');
  for (const db of dbs) {
    lines.push(`## ${db}`, '');
    lines.push('| cell | VUs | req/s | http p50 | http p95 | http p99 | db p50 | db p95 | db p99 | rows/op | errors | uk |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const o of outcomes.filter((x) => x.db === db && x.status === 'ok')) {
      const c = o.compact!;
      lines.push(`| ${o.cell} | ${o.vus} | ${fmt(c.reqs?.rate)} | ${fmt(c.http_req_duration?.med)} | ${fmt(c.http_req_duration?.['p(95)'])} | ` +
        `${fmt(c.http_req_duration?.['p(99)'])} | ${fmt(c.db_ms?.med)} | ${fmt(c.db_ms?.['p(95)'])} | ${fmt(c.db_ms?.['p(99)'])} | ` +
        `${fmt(c.rows?.avg)} | ${fmt(c.errors?.count) || 0} | ${fmt(c.uk_violations?.count) || 0} |`);
    }
    const notRun = outcomes.filter((x) => x.db === db && x.status !== 'ok');
    if (notRun.length) {
      lines.push('', '**Not run**', '');
      for (const o of notRun) lines.push(`- ${o.cell}${o.vus ? ` @ ${o.vus}` : ''}: ${o.status === 'na' ? 'N/A' : 'failed'} -- ${o.reason}`);
    }
    lines.push('');
  }
  await Bun.write(resolve(dir, 'summary.md'), lines.join('\n'));
  await Bun.write(resolve(dir, 'outcomes.json'), JSON.stringify(outcomes, null, 2));
}
