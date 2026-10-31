/**
 * Reads back what runSuite wrote to results/<run-id>/, for the results page.
 *
 *   results/<run-id>/run.json            request + resolved config (written first)
 *   results/<run-id>/outcomes.json       every cell's status and compact numbers (written last)
 *   results/<run-id>/summary.md          the same as a markdown table
 *   results/<run-id>/<db>/initialize.json
 *   results/<run-id>/<db>/<cell>@<vus>.json   k6's summary: { compact, full }
 *
 * A run with no outcomes.json was stopped hard, crashed, or is still going; its
 * outcomes are rebuilt from the per-cell k6 files that did land.
 */

import { readdir, stat } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { PATHS } from '../config/paths.ts';
import { BadParams, HttpError } from '../http/errors.ts';
import type { Compact } from './events.ts';

export interface Outcome {
  db: string;
  cell: string;
  vus?: number;
  status: 'ok' | 'na' | 'failed';
  reason?: string;
  compact?: Compact;
}

export interface FileEntry {
  /** Relative to the run folder, always with forward slashes. */
  path: string;
  bytes: number;
}

export interface RunListItem {
  id: string;
  /** ISO time the run started, parsed back from the id. */
  startedAt: string | null;
  /** Last write in the folder. */
  updatedAt: string;
  complete: boolean;
  profile: string | null;
  dbs: string[];
  tests: string[];
  concurrency: number[];
  durationSec: number | null;
  counts: { ok: number; na: number; failed: number };
  files: number;
  bytes: number;
}

export interface RunDetail extends RunListItem {
  run: { request?: Record<string, unknown>; config?: Record<string, unknown> } | null;
  outcomes: Outcome[];
  /** Per database, its initialize.json (null when the run did not initialize it). */
  initialize: Record<string, unknown>;
  summary: string | null;
  tree: FileEntry[];
}

/** `2026-10-31T06-54-18-237Z` back to `2026-10-31T06:54:18.237Z`. */
function startedAt(id: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

function runDir(id: string): string {
  if (!/^[\w-]+$/.test(id)) throw new BadParams('bad run id');
  return resolve(PATHS.results, id);
}

async function readJson<T>(path: string): Promise<T | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return (await file.json()) as T;
  } catch {
    return null; // half-written
  }
}

async function walk(dir: string): Promise<{ files: FileEntry[]; mtime: number }> {
  const files: FileEntry[] = [];
  let mtime = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
    if (!e.isFile()) continue;
    const full = resolve(e.parentPath, e.name);
    const s = await stat(full);
    mtime = Math.max(mtime, s.mtimeMs);
    files.push({ path: relative(dir, full).split(sep).join('/'), bytes: s.size });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en', { numeric: true }));
  return { files, mtime };
}

/** `r10_array-contains_100@1.json` -> { cell: 'r10 array-contains 100', vus: 1 } (inverse of runCell's file name). */
function parseCellFile(name: string): { cell: string; vus: number } | null {
  const m = /^(.+)@(\d+)\.json$/.exec(name);
  return m ? { cell: m[1]!.replace(/_/g, ' '), vus: Number(m[2]) } : null;
}

async function recoverOutcomes(dir: string, files: FileEntry[]): Promise<Outcome[]> {
  const out: Outcome[] = [];
  for (const f of files) {
    const [db, name, ...rest] = f.path.split('/');
    if (!name || rest.length) continue;
    const parsed = parseCellFile(name);
    if (!parsed) continue;
    const k6 = await readJson<{ compact?: Compact }>(resolve(dir, f.path));
    if (k6?.compact) out.push({ db: db!, ...parsed, status: 'ok', compact: k6.compact });
  }
  return out;
}

async function load(id: string): Promise<RunDetail> {
  const dir = runDir(id);
  if (!(await stat(dir).catch(() => null))?.isDirectory()) throw new HttpError(404, `no run ${id}`, 'not_found');

  const { files, mtime } = await walk(dir);
  const run = await readJson<RunDetail['run'] & object>(resolve(dir, 'run.json'));
  const written = await readJson<Outcome[]>(resolve(dir, 'outcomes.json'));
  const outcomes = written ?? (await recoverOutcomes(dir, files));

  const req = (run?.request ?? {}) as { dbs?: string[]; tests?: string[] };
  const cfg = (run?.config ?? {}) as { profile?: string; concurrency?: number[]; run?: { durationSec?: number } };
  const dbFolders = [...new Set(files.filter((f) => f.path.includes('/')).map((f) => f.path.split('/')[0]!))];

  const initialize: Record<string, unknown> = {};
  for (const db of dbFolders) {
    const init = await readJson(resolve(dir, db, 'initialize.json'));
    if (init) initialize[db] = init;
  }

  const counts = { ok: 0, na: 0, failed: 0 };
  for (const o of outcomes) counts[o.status]++;
  const summary = files.some((f) => f.path === 'summary.md') ? await Bun.file(resolve(dir, 'summary.md')).text() : null;

  return {
    id,
    startedAt: startedAt(id),
    updatedAt: new Date(mtime || Date.now()).toISOString(),
    complete: written !== null,
    profile: cfg.profile ?? null,
    dbs: req.dbs ?? dbFolders,
    tests: req.tests ?? [],
    concurrency: cfg.concurrency ?? [],
    durationSec: cfg.run?.durationSec ?? null,
    counts,
    files: files.length,
    bytes: files.reduce((a, f) => a + f.bytes, 0),
    run,
    outcomes,
    initialize,
    summary,
    tree: files,
  };
}

/** Every run, newest first. */
export async function listRuns(): Promise<RunListItem[]> {
  const entries = await readdir(PATHS.results, { withFileTypes: true }).catch(() => []);
  const ids = entries.filter((e) => e.isDirectory() && /^[\w-]+$/.test(e.name)).map((e) => e.name);
  const runs = await Promise.all(ids.map((id) => load(id).catch(() => null)));
  return runs
    .filter((r): r is RunDetail => r !== null)
    .map(({ run: _r, outcomes: _o, initialize: _i, summary: _s, tree: _t, ...item }) => item)
    .sort((a, b) => b.id.localeCompare(a.id));
}

export const getRun = load;

/** One file inside a run, as a Response. `path` is relative to the run folder. */
export async function runFile(id: string, path: string): Promise<Response> {
  const dir = runDir(id);
  const full = resolve(dir, path);
  // No climbing out of the run folder.
  if (!path || !full.startsWith(dir + sep)) throw new BadParams('bad file path');
  const file = Bun.file(full);
  if (!(await file.exists())) throw new HttpError(404, `no file ${path} in run ${id}`, 'not_found');
  const type = full.endsWith('.json') ? 'application/json' : full.endsWith('.md') ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8';
  return new Response(file, { headers: { 'content-type': type } });
}
