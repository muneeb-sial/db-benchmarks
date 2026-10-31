/**
 * Terminal client for POST /api/suite: the same run the UI's Suite tab starts,
 * printed line by line as it streams.
 *
 *   bun src/suite/cli.ts --db postgres,mysql [--tests r1,r2,w1] [--concurrency 1,8,32]
 *                           [--limits 100,1k] [--duration 5] [--warmup 1] [--verbose]
 *                           [--skip-init] [--no-indexes] [--dry-run] [--base-url http://localhost:3000]
 *
 * The server must be running; its profile (BENCH_PROFILE) decides the seed and
 * the defaults. Flags override the matrix for this run only. Ctrl+C stops the
 * run and the server kills the k6 process in flight.
 */

import { parseArgs } from 'node:util';
import { formatEvent, type SuiteEvent } from './events.ts';

const { values } = parseArgs({
  options: {
    db: { type: 'string' },
    tests: { type: 'string' },
    concurrency: { type: 'string' },
    limits: { type: 'string' },
    shapes: { type: 'string' },
    modes: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    verbose: { type: 'boolean', default: false },
    'skip-init': { type: 'boolean', default: false },
    'no-indexes': { type: 'boolean', default: false },
    'dry-run': { type: 'boolean', default: false },
    'base-url': { type: 'string', default: 'http://localhost:3000' },
  },
});

if (!values.db) {
  console.error('usage: bun src/suite/cli.ts --db postgres[,mysql,...] [--tests r1,w1] [--concurrency 1,8] [--dry-run]');
  process.exit(2);
}

const list = (v: string | undefined): string[] | undefined => v?.split(',').map((s) => s.trim()).filter(Boolean);
const overrides: Record<string, unknown> = {};
if (values.concurrency) overrides.concurrency = list(values.concurrency)!.map(Number);
if (values.limits) overrides.limits = list(values.limits);
if (values.shapes) overrides.shapes = list(values.shapes);
if (values.modes) overrides.readModes = list(values.modes);
if (values.duration || values.warmup) {
  overrides.run = {
    ...(values.duration ? { durationSec: Number(values.duration) } : {}),
    ...(values.warmup ? { warmupSec: Number(values.warmup) } : {}),
  };
}

const body = JSON.stringify({
  dbs: list(values.db),
  tests: list(values.tests),
  initialize: !values['skip-init'],
  indexes: !values['no-indexes'],
  verbose: values.verbose,
  overrides,
});
const BASE = values['base-url']!.replace(/\/$/, '');
const COLOR = { info: '', head: '\x1b[1m', ok: '\x1b[32m', na: '\x1b[33m', fail: '\x1b[31m', raw: '\x1b[2m' } as const;

const print = (e: SuiteEvent): void => {
  const f = formatEvent(e);
  if (f) console.log(`${COLOR[f.level]}${f.text}\x1b[0m`);
};

const abort = new AbortController();
process.on('SIGINT', () => abort.abort());

const res = await fetch(`${BASE}/api/suite${values['dry-run'] ? '/plan' : ''}`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body,
  signal: abort.signal,
}).catch((err) => {
  console.error(`cannot reach the server at ${BASE}: ${(err as Error).message}`);
  process.exit(2);
});

if (!res.ok || !res.body) {
  const err = (await res.json().catch(() => ({}))) as { message?: string };
  console.error(`${res.status}: ${err.message ?? 'request failed'}`);
  process.exit(1);
}
if (values['dry-run']) {
  print((await res.json()) as SuiteEvent);
  process.exit(0);
}

let failed = 0;
let rest = '';
const decoder = new TextDecoder();
try {
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split('\n');
    rest = lines.pop() ?? '';
    for (const line of lines) {
      if (!line) continue;
      const e = JSON.parse(line) as SuiteEvent;
      if (e.type === 'done') failed = e.failed;
      if (e.type === 'error') failed++;
      print(e);
    }
  }
} catch (err) {
  if (!abort.signal.aborted) throw err;
  console.log('\nstopped');
}
process.exit(failed ? 1 : 0);
