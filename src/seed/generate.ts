/**
 * Writes the seed files every engine loads on POST /:db/initialize.
 *
 *   bun src/seed/generate.ts [--profile smoke]
 *
 * Output (gitignored): src/seed/data/{users,posts,likes,documents}.jsonl
 * plus manifest.json. One JSON row per line, dates as ISO strings. Output is
 * deterministic, so regenerating with the same config gives identical files.
 */

import { mkdir, rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { loadConfig } from '../config/config.ts';
import type { Row, SeedTable } from '../engine/types.ts';
import { DATA_DIR, MANIFEST_PATH, manifestFor, planFromManifest, tablePath } from './manifest.ts';
import { docRow, likeRow, postRow, userRow, type Plan } from './rows.ts';

const { values } = parseArgs({ options: { profile: { type: 'string' } } });
const cfg = await loadConfig(values.profile);
const manifest = manifestFor(cfg);
const plan = planFromManifest(manifest);

await mkdir(DATA_DIR, { recursive: true });
// Remove the manifest first, so an interrupted run never leaves a manifest over half-written files.
await rm(MANIFEST_PATH, { force: true });

async function write(table: SeedTable, count: number, make: (p: Plan, id: number) => Row): Promise<void> {
  const t0 = performance.now();
  // FileSink does not truncate: a smaller seed over a larger one would keep the old tail.
  await rm(tablePath(table), { force: true });
  const sink = Bun.file(tablePath(table)).writer({ highWaterMark: 1 << 20 });
  for (let id = 1; id <= count; id++) sink.write(JSON.stringify(make(plan, id)) + '\n');
  await sink.end();
  console.log(`  ${table}: ${count.toLocaleString('en-US')} rows in ${Math.round(performance.now() - t0)}ms`);
}

console.log(`generating seed (profile ${cfg.profile}, seed ${manifest.seed}) into ${DATA_DIR}`);
await write('users', manifest.users, userRow);
await write('posts', manifest.posts, postRow);
await write('likes', manifest.likes, likeRow);
await write('documents', manifest.documents, docRow);
// The manifest goes last: its presence means the data files are complete.
await Bun.write(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');
console.log('done');
