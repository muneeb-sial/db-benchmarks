/**
 * The manifest describes what is in seed/data. Initialize refuses to load
 * files whose manifest does not match the current config, so a run can never
 * silently test against data of a different size or seed.
 */

import { resolve } from 'node:path';
import type { DocShape, ServerConfig } from '../config/config.ts';
import { PATHS } from '../config/paths.ts';
import { SeedMissing } from '../http/errors.ts';
import type { SeedTable } from '../engine/types.ts';
import { GENERATOR_VERSION, plantedBlocks, type Plan } from './rows.ts';

export const DATA_DIR = PATHS.seedData;
export const MANIFEST_PATH = resolve(DATA_DIR, 'manifest.json');
export const tablePath = (table: SeedTable): string => resolve(DATA_DIR, `${table}.jsonl`);

export interface Manifest {
  generatorVersion: number;
  profile: string;
  seed: number;
  users: number;
  posts: number;
  likes: number;
  documents: number;
  limits: number[];
  docShape: DocShape;
}

export function manifestFor(cfg: ServerConfig): Manifest {
  return {
    generatorVersion: GENERATOR_VERSION,
    profile: cfg.profile,
    seed: cfg.dataset.seed,
    users: cfg.dataset.users,
    posts: cfg.dataset.posts,
    likes: cfg.dataset.likes,
    documents: cfg.dataset.documents,
    limits: cfg.limits,
    docShape: cfg.reads.r10.docShape,
  };
}

export function planFromManifest(m: Manifest): Plan {
  return {
    seed: m.seed,
    users: m.users,
    posts: m.posts,
    likes: m.likes,
    documents: m.documents,
    blocks: plantedBlocks(m.limits),
    docShape: m.docShape,
  };
}

/** Reads the manifest and checks it against the config. Throws SeedMissing (424) otherwise. */
export async function readManifest(cfg: ServerConfig): Promise<Manifest> {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) throw new SeedMissing(`no seed found at ${MANIFEST_PATH}`, cfg.profile);
  const found = (await file.json()) as Manifest;
  const want = manifestFor(cfg);

  const diffs: string[] = [];
  for (const key of ['generatorVersion', 'seed', 'users', 'posts', 'likes', 'documents'] as const) {
    if (found[key] !== want[key]) diffs.push(`${key}: seed has ${found[key]}, config wants ${want[key]}`);
  }
  if (JSON.stringify(found.limits) !== JSON.stringify(want.limits)) diffs.push('limits differ');
  if (JSON.stringify(found.docShape) !== JSON.stringify(want.docShape)) diffs.push('docShape differs');
  if (diffs.length) {
    throw new SeedMissing(`seed was generated for profile "${found.profile}" and does not match (${diffs.join('; ')})`, cfg.profile);
  }

  for (const t of ['users', 'posts', 'likes', 'documents'] as const) {
    if (!(await Bun.file(tablePath(t)).exists())) throw new SeedMissing(`seed file ${tablePath(t)} is missing`, cfg.profile);
  }
  return found;
}
