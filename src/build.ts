/**
 * Builds the project into dist/:
 *
 *   bun run build          (typechecks first; see package.json)
 *   bun run start          runs the built server: bun dist/index.js
 *
 * Output, mirroring src/ so config/paths.ts finds everything from dist/:
 *   dist/index.js              the server, with the UI page pre-bundled
 *   dist/seed/generate.js      the seed generator
 *   dist/suite/cli.js          the terminal client for /api/suite
 *   dist/config/bench.config.json, dist/databases/<db>/docker-compose.yml,
 *   dist/k6/*.js               copied as-is (k6 runs the scripts itself)
 *   dist/seed/data/            the seed files, copied if they exist
 *
 * Drivers stay external: dist/ resolves them from the repo's node_modules.
 */

import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

const SRC = import.meta.dir;
const DIST = resolve(SRC, '..', 'dist');

const t0 = performance.now();
// Empty dist/ rather than deleting it: Windows refuses to remove a folder that
// is some process's working directory (a terminal cd'd into it, a running build).
await mkdir(DIST, { recursive: true });
for (const entry of await readdir(DIST)) await rm(resolve(DIST, entry), { recursive: true, force: true });

/**
 * One build per entry point, each self-contained. The server's build also
 * bundles its HTML page; Bun's full-stack bundling loses the page's chunks
 * when they are split and shared with other entry points, so nothing is shared.
 */
const ENTRIES = [
  { entry: 'index.ts', outdir: '.' },
  { entry: 'seed/generate.ts', outdir: 'seed' },
  { entry: 'suite/cli.ts', outdir: 'suite' },
];
const outputs: string[] = [];
let files = 0;
for (const { entry, outdir } of ENTRIES) {
  const result = await Bun.build({
    entrypoints: [resolve(SRC, entry)],
    outdir: resolve(DIST, outdir),
    target: 'bun',
    packages: 'external',
    sourcemap: 'linked',
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }
  files += result.outputs.length;
  outputs.push(...result.outputs.filter((o) => o.kind === 'entry-point').map((o) => o.path.slice(DIST.length + 1)));
}

// Runtime files, at the same relative paths as in src/.
await mkdir(resolve(DIST, 'config'), { recursive: true });
await cp(resolve(SRC, 'config', 'bench.config.json'), resolve(DIST, 'config', 'bench.config.json'));
for (const db of await readdir(resolve(SRC, 'databases'), { withFileTypes: true })) {
  if (!db.isDirectory()) continue;
  const compose = resolve(SRC, 'databases', db.name, 'docker-compose.yml');
  if (await Bun.file(compose).exists()) {
    await cp(compose, resolve(DIST, 'databases', db.name, 'docker-compose.yml'));
  }
}
await mkdir(resolve(DIST, 'k6'), { recursive: true });
for (const f of await readdir(resolve(SRC, 'k6'))) {
  if (f.endsWith('.js')) await cp(resolve(SRC, 'k6', f), resolve(DIST, 'k6', f));
}
const seedData = resolve(SRC, 'seed', 'data');
const hasSeed = await Bun.file(resolve(seedData, 'manifest.json')).exists();
if (hasSeed) await cp(seedData, resolve(DIST, 'seed', 'data'), { recursive: true });

console.log(`built ${files} files into dist/ in ${Math.round(performance.now() - t0)}ms`);
console.log(`  entry points: ${outputs.join(', ')}`);
console.log(`  copied: config, ${(await readdir(resolve(DIST, 'databases'))).length} compose files, k6 scripts` +
  (hasSeed ? ', seed data' : ''));
if (!hasSeed) console.log('  no seed yet: generate one with `bun dist/seed/generate.js` (or `bun run seed`, then rebuild)');
console.log('run it: bun run start');
