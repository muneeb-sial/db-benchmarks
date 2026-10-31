/**
 * Every file the server reads or writes at runtime, resolved from one base.
 *
 * The base is the folder that holds config/bench.config.json: `src/` when run
 * from source, `dist/` when run from the build (`bun run build`), which copies
 * the same layout there. Paths are never resolved per-file, because bundling
 * collapses every module into dist/ and per-file `import.meta.dir` would lie.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

function findBase(): string {
  let dir = import.meta.dir;
  for (;;) {
    if (existsSync(resolve(dir, 'config', 'bench.config.json'))) return dir;
    const up = dirname(dir);
    if (up === dir) throw new Error(`config/bench.config.json not found in or above ${import.meta.dir}`);
    dir = up;
  }
}

/** `src/` from source, `dist/` from the build. */
export const BASE = findBase();
/** The repo root (BASE's parent in both cases). */
export const ROOT = resolve(BASE, '..');

export const PATHS = {
  config: resolve(BASE, 'config', 'bench.config.json'),
  /** One folder per engine, each with its docker-compose.yml. */
  databases: resolve(BASE, 'databases'),
  /** The k6 test scripts (plain JS that k6 runs, not part of the bundle). */
  k6: resolve(BASE, 'k6'),
  /** Generated seed files (gitignored). */
  seedData: resolve(BASE, 'seed', 'data'),
  /** Run output, always at the repo root. */
  results: resolve(ROOT, 'results'),
};
