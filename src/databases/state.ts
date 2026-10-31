/**
 * Which databases are initialized, which search indexes they have, and the
 * initialize procedure itself: fresh container, schema, seed load, baseline
 * indexes, then (by default) every search index the engine supports. Shared
 * by POST /:db/initialize, the index routes and the suite runner.
 *
 * Search indexes stay until the container is recreated or someone drops one.
 * The suite only takes one away for the moment a no-index cell needs it gone.
 */

import type { ServerConfig } from '../config/config.ts';
import { recreate } from './docker.ts';
import type { Engine } from '../engine/engine.ts';
import { INDEX_KINDS, type IndexKind } from '../engine/types.ts';
import { HttpError, NotInitialized } from '../http/errors.ts';
import { loadAll } from '../seed/load.ts';
import { planFromManifest, readManifest, type Manifest } from '../seed/manifest.ts';
import type { Plan } from '../seed/rows.ts';

export interface DbState {
  manifest: Manifest;
  plan: Plan;
  loadMs: Record<string, number>;
  /** Build time per search index at initialize. */
  indexMs: Partial<Record<IndexKind, number>>;
  /** Search indexes that exist right now. */
  indexes: IndexKind[];
  initializedAt: string;
}

export interface Initialized {
  db: string;
  container: { downMs: number; upMs: number; output: string };
  loadMs: Record<string, number>;
  indexMs: Partial<Record<IndexKind, number>>;
  indexes: IndexKind[];
  manifest: Manifest;
  engine: Record<string, string>;
}

export interface InitOptions {
  /** Build every supported search index after the load (default true). */
  indexes?: boolean;
}

const state = new Map<string, DbState>();
const initializing = new Set<string>();

export const dbState = (db: string): DbState | undefined => state.get(db);
export const isInitializing = (db: string): boolean => initializing.has(db);

export function ready(db: string): DbState {
  const s = state.get(db);
  if (!s) throw new NotInitialized(db);
  return s;
}

export async function initialize(
  db: string,
  cfg: ServerConfig,
  log: (s: string) => void = console.log,
  opts: InitOptions = {},
): Promise<Initialized> {
  if (initializing.has(db)) throw new HttpError(409, `${db} is already initializing`, 'busy');
  // Seed first: no point recreating a container for a load that will fail.
  const manifest = await readManifest(cfg);
  initializing.add(db);
  state.delete(db);
  try {
    const { engine, downMs, upMs, composeOutput } = await recreate(db, log);
    const loadMs = await load(engine, manifest, cfg, log);
    const { indexMs, indexes } = opts.indexes === false ? { indexMs: {}, indexes: [] } : await buildSearchIndexes(engine, log);
    state.set(db, { manifest, plan: planFromManifest(manifest), loadMs, indexMs, indexes, initializedAt: new Date().toISOString() });
    return {
      db,
      container: { downMs, upMs, output: composeOutput },
      loadMs,
      indexMs,
      indexes,
      manifest,
      engine: await engine.describe(),
    };
  } finally {
    initializing.delete(db);
  }
}

async function load(engine: Engine, manifest: Manifest, cfg: ServerConfig, log: (s: string) => void): Promise<Record<string, number>> {
  const t0 = performance.now();
  engine.docPath = [...Array.from({ length: manifest.docShape.nestedDepth }, (_, d) => `l${d + 1}`), 'value'];
  await engine.resetSchema();
  const loadMs = await loadAll(engine, cfg.dataset.loadChunk, log);
  const a0 = performance.now();
  await engine.afterLoad();
  loadMs.afterLoad = Math.round(performance.now() - a0);
  loadMs.total = Math.round(performance.now() - t0);
  return loadMs;
}

/** Every search index the engine supports; N/A kinds (support('index') reason) are skipped. */
async function buildSearchIndexes(
  engine: Engine,
  log: (s: string) => void,
): Promise<{ indexMs: Partial<Record<IndexKind, number>>; indexes: IndexKind[] }> {
  const indexMs: Partial<Record<IndexKind, number>> = {};
  const present = new Set<IndexKind>();
  for (const kind of INDEX_KINDS) {
    if (engine.support('index', { kind }) || present.has(kind)) continue;
    const t0 = performance.now();
    await engine.createIndex(kind);
    indexMs[kind] = Math.round(performance.now() - t0);
    for (const k of engine.sharedIndexes(kind)) present.add(k);
    log(`  ${engine.name}: built search index ${kind} in ${indexMs[kind]}ms`);
  }
  return { indexMs, indexes: INDEX_KINDS.filter((k) => present.has(k)) };
}

/**
 * Makes `kind` present or absent. Returns the time taken in ms, or null if it
 * was already in that state. Keeps DbState.indexes in step, including kinds
 * that share the same physical index.
 */
export async function setIndex(db: string, engine: Engine, kind: IndexKind, present: boolean): Promise<number | null> {
  const s = ready(db);
  if (s.indexes.includes(kind) === present) return null;
  const t0 = performance.now();
  if (present) await engine.createIndex(kind);
  else await engine.dropIndex(kind);
  const ms = performance.now() - t0;
  const shared = new Set(engine.sharedIndexes(kind));
  const now = new Set(s.indexes.filter((k) => !shared.has(k)));
  if (present) for (const k of shared) now.add(k);
  s.indexes = INDEX_KINDS.filter((k) => now.has(k));
  return ms;
}
