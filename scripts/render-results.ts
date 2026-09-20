/**
 * Renders the newest result.json into README.md, between the <!-- start --> and
 * <!-- end --> markers.
 *
 * Replaces the old update-readme.js, which pasted a console.table dump into the
 * README. It is run by hand rather than by CI: benchmark numbers now come from
 * local runs on controlled hardware, because a shared CI runner is a noisy
 * neighbour and its absolute figures were never defensible.
 *
 *   node scripts/render-results.ts [resultsDir]
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { renderMarkdown, type BenchmarkRun } from '../src/core/reporter.ts';

const resultsDir = process.argv[2] ?? 'results';
const START = '<!-- start -->';
const END = '<!-- end -->';

const entries = await readdir(resultsDir, { withFileTypes: true });
const runDirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort();

const latest = runDirs.at(-1);
if (!latest) {
  console.error(`no run directories in ${resultsDir}/ — run a benchmark first`);
  process.exit(1);
}

const jsonPath = path.join(resultsDir, latest, 'result.json');
const run = JSON.parse(await readFile(jsonPath, 'utf8')) as BenchmarkRun;

const readmePath = 'README.md';
const readme = await readFile(readmePath, 'utf8');
const startIdx = readme.indexOf(START);
const endIdx = readme.indexOf(END);

if (startIdx === -1 || endIdx === -1) {
  console.error(`README.md is missing the ${START} / ${END} markers`);
  process.exit(1);
}

const next =
  readme.slice(0, startIdx + START.length) +
  '\n\n' +
  renderMarkdown(run) +
  '\n' +
  readme.slice(endIdx);

await writeFile(readmePath, next, 'utf8');
console.log(`README.md updated from ${jsonPath}`);
