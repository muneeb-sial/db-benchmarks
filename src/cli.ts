/**
 * Benchmark entry point. Runs identically under Node and Bun. Deno is unsupported.
 *
 *   node src/cli.ts --db postgres --profile smoke --tests r1,r4
 *   bun  src/cli.ts --db postgres,mysql --concurrency 1,8,32
 */

import process from 'node:process';
import { parseArgs } from 'node:util';
import { ENGINES, ENGINE_NAMES } from './core/registry.ts';
import { assertSupportedRuntime, detectRuntime, hostInfo } from './core/runtime.ts';
import {
  newRunId,
  renderConsole,
  writeResults,
  type BenchmarkRun,
  type EngineResult,
} from './core/reporter.ts';
import { loadConfig } from './suite/config.ts';
import { runSuite } from './suite/run.ts';
import { ALL_TEST_IDS, parseTests } from './suite/tests.ts';
import type { Adapter } from './core/adapter.ts';

assertSupportedRuntime();

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: ENGINE_NAMES.join(',') },
    // No defaults for these four: the config file supplies them, and an
    // explicit flag must be distinguishable from "not given".
    concurrency: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    repeats: { type: 'string' },
    out: { type: 'string', default: 'results' },
    host: { type: 'string' },
    port: { type: 'string' },
    tests: { type: 'string' },
    profile: { type: 'string' },
    config: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
db-benchmarks — write/read benchmark suite (features.md, W1-W4 and R1-R10)
across ${ENGINE_NAMES.join(', ')}

  --db            comma list: ${ENGINE_NAMES.join(', ')}      (default: all)
  --tests         comma list: ${ALL_TEST_IDS.join(', ')}, writes, reads, all   (default: all)
  --profile       named profile from the config: smoke, standard, full
  --config        config file                                 (default: bench.config.json)
                  Every number in the suite (limits, concurrency, batch sizes,
                  dataset size, ...) is set there. --concurrency, --duration,
                  --warmup and --repeats override it when given.
  --concurrency   comma list of in-flight levels
  --duration      measured seconds per cell
  --warmup        discarded seconds per cell
  --repeats       repetitions per cell, median reported
  --out           output directory                            (default: results)
  --host/--port   override the engine's default connection

Each database has its own compose file, e.g.:
  cd databases/postgres && docker compose up -d
`);
  process.exit(0);
}

const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string | undefined, fallback: number): number => {
  const v = Number(s);
  return Number.isFinite(v) ? v : fallback;
};
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const engines = list(values.db!);

const runtime = detectRuntime();
console.log(`runtime: ${runtime} ${hostInfo().runtimeVersion}`);

const suiteCfg = await loadConfig({ path: values.config, profile: values.profile }).catch(
  (err: unknown) => {
    console.error(message(err));
    process.exit(1);
  },
);
let suiteSelection: Set<string> | null;
try {
  suiteSelection = parseTests(values.tests);
} catch (err) {
  console.error(message(err));
  process.exit(1);
}

// Explicit flags win over the config file.
if (values.concurrency) suiteCfg.concurrency = list(values.concurrency).map((c) => num(c, 1));
if (values.duration) suiteCfg.run.durationSec = num(values.duration, suiteCfg.run.durationSec);
if (values.warmup) suiteCfg.run.warmupSec = num(values.warmup, suiteCfg.run.warmupSec);
if (values.repeats) suiteCfg.run.repeats = num(values.repeats, suiteCfg.run.repeats);

console.log(
  `suite: profile ${values.profile ?? 'default'}, ` +
    `concurrency ${suiteCfg.concurrency.join(',')}, limits ${suiteCfg.limits.join(',')}, ` +
    `dataset ${suiteCfg.dataset.users.toLocaleString('en-US')} users / ` +
    `${suiteCfg.dataset.posts.toLocaleString('en-US')} posts / ` +
    `${suiteCfg.dataset.likes.toLocaleString('en-US')} likes, ` +
    `${suiteCfg.run.durationSec}s + ${suiteCfg.run.warmupSec}s warmup x ${suiteCfg.run.repeats}`,
);

const run: BenchmarkRun = {
  runId: newRunId(),
  startedAt: new Date().toISOString(),
  host: hostInfo(),
  config: {
    engines,
    // The fully-resolved suite config, so a run can be reproduced exactly.
    suite: suiteCfg,
    suiteTests: suiteSelection ? [...suiteSelection] : 'all',
  },
  engines: [],
};

for (const name of engines) {
  const descriptor = ENGINES[name];
  if (!descriptor) {
    console.error(`unknown engine "${name}" — known: ${ENGINE_NAMES.join(', ')}`);
    process.exit(1);
  }

  let adapter: Adapter;
  try {
    adapter = await descriptor.load();
  } catch (err) {
    run.engines.push(skipped(name, name, `driver failed to load: ${message(err)}`));
    continue;
  }

  // Runtimes x databases is not a full grid. Skipping loudly beats a confusing
  // driver-level crash halfway through a long run.
  if (!adapter.supportedRuntimes.includes(runtime)) {
    console.log(
      `${adapter.displayName}: skipped — driver is not verified on ${runtime} ` +
        `(supported: ${adapter.supportedRuntimes.join(', ')})`,
    );
    run.engines.push(
      skipped(adapter.engine, adapter.displayName, `driver not verified on ${runtime}`),
    );
    continue;
  }

  const opts = {
    ...descriptor.defaults,
    ...(values.host ? { host: values.host } : {}),
    ...(values.port ? { port: num(values.port, descriptor.defaults.port) } : {}),
  };

  try {
    console.log(`\n--- ${adapter.displayName} ---`);
    await adapter.connect(opts);
    run.engines.push(await benchmarkEngine(adapter));
  } catch (err) {
    console.error(`${adapter.displayName}: ${message(err)}`);
    run.engines.push(skipped(adapter.engine, adapter.displayName, message(err)));
  } finally {
    await adapter.close().catch(() => {});
  }
}

renderConsole(run);
const jsonPath = await writeResults(run, values.out!);
console.log(`\nwrote ${jsonPath}`);

async function benchmarkEngine(adapter: Adapter): Promise<EngineResult> {
  const version = await adapter.serverVersion();
  console.log(`connected: ${version}`);

  console.log('  running the suite');
  const suite = await runSuite({
    adapter,
    cfg: suiteCfg,
    selection: suiteSelection,
    log: (line) => console.log(line),
  });

  return {
    engine: adapter.engine,
    displayName: adapter.displayName,
    serverVersion: version,
    memoryConfig: await adapter.memoryConfig().catch(() => ({})),
    suite,
  };
}

function skipped(engine: string, displayName: string, reason: string): EngineResult {
  return {
    engine,
    displayName,
    serverVersion: '—',
    memoryConfig: {},
    skipped: reason,
  };
}
