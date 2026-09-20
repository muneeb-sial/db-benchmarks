/**
 * Benchmark entry point. Runs identically under Node and Bun. Deno is unsupported.
 *
 *   node src/cli.ts --db postgres --workload like-tx --duration 10
 *   bun  src/cli.ts --db postgres,mysql --concurrency 1,8,32
 *   node src/cli.ts --suite --profile smoke --db postgres --tests r1,r4
 */

import process from 'node:process';
import { parseArgs } from 'node:util';
import { ENGINES, ENGINE_NAMES } from './core/registry.ts';
import { runClosedLoop, type RunResult } from './core/runner.ts';
import { assertSupportedRuntime, detectRuntime, hostInfo } from './core/runtime.ts';
import { median } from './core/stats.ts';
import {
  newRunId,
  renderConsole,
  writeResults,
  type BenchmarkRun,
  type Cell,
  type EngineResult,
} from './core/reporter.ts';
import { chunk, generate, type Dataset } from './dataset/generate.ts';
import { buildLikeOp, Contention } from './workloads/like-tx.ts';
import { buildReadOp, ReadWorkload } from './workloads/read.ts';
import { loadConfig, type SuiteConfig } from './suite/config.ts';
import { runSuite } from './suite/run.ts';
import { ALL_TEST_IDS, parseTests } from './suite/tests.ts';
import type { Adapter } from './core/adapter.ts';

assertSupportedRuntime();

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: ENGINE_NAMES.join(',') },
    // No defaults for the next five: legacy runs and the suite have different
    // defaults, and the suite must be able to tell "not given" from "given".
    workload: { type: 'string' },
    concurrency: { type: 'string' },
    duration: { type: 'string' },
    warmup: { type: 'string' },
    repeats: { type: 'string' },
    contention: { type: 'string', default: 'uniform,hot' },
    users: { type: 'string', default: '20000' },
    'posts-per-user': { type: 'string', default: '2' },
    limit: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: 'results' },
    host: { type: 'string' },
    port: { type: 'string' },
    suite: { type: 'boolean', default: false },
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
db-benchmarks — benchmarks across ${ENGINE_NAMES.join(', ')}

  --db            comma list: ${ENGINE_NAMES.join(', ')}      (default: all)
  --out           output directory                            (default: results)
  --host/--port   override the engine's default connection

Transactional workloads (the original harness):
  --workload      comma list: like-tx, ${Object.values(ReadWorkload).join(', ')}   (default: like-tx)
  --contention    comma list: uniform, hot                    (like-tx only)
  --concurrency   comma list of in-flight levels              (default: 1,8,32,64)
  --duration      measured seconds per cell                   (default: 10)
  --warmup        discarded seconds per cell                  (default: 3)
  --repeats       repetitions per cell, median reported       (default: 3)
  --users         users to generate                           (default: 20000)
  --posts-per-user                                            (default: 2)
  --limit         row limit for scan workloads                (default: 1000)
  --seed          dataset seed                                (default: 42)

Write/read benchmark suite (features.md, W1-W4 and R1-R10):
  --suite         run the suite (skips like-tx unless --workload is also given)
  --tests         comma list: ${ALL_TEST_IDS.join(', ')}, writes, reads, all   (default: all)
  --profile       named profile from the config: smoke, standard, full
  --config        config file                                 (default: bench.config.json)
                  Every number in the suite (limits, concurrency, batch sizes,
                  dataset size, ...) is set there. --concurrency, --duration,
                  --warmup and --repeats override it when given.

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

const suiteMode = values.suite === true;
const engines = list(values.db!);
const workloads = values.workload ? list(values.workload) : suiteMode ? [] : ['like-tx'];
const legacyMode = workloads.length > 0;
const contentions = list(values.contention!);
const concurrencies = list(values.concurrency ?? '1,8,32,64').map((c) => num(c, 1));
const durationMs = num(values.duration, 10) * 1000;
const warmupMs = num(values.warmup, 3) * 1000;
const repeats = num(values.repeats, 3);
const userCount = num(values.users, 20000);
const postsPerUser = num(values['posts-per-user'], 2);
const scanLimit = num(values.limit, 1000);
const seed = num(values.seed, 42);

const runtime = detectRuntime();
console.log(`runtime: ${runtime} ${hostInfo().runtimeVersion}`);

// ------------------------------------------------------------------ suite --

let suiteCfg: SuiteConfig | null = null;
let suiteSelection: Set<string> | null = null;

if (suiteMode) {
  try {
    suiteCfg = await loadConfig({ path: values.config, profile: values.profile });
    suiteSelection = parseTests(values.tests);
  } catch (err) {
    console.error(message(err));
    process.exit(1);
  }
  // Explicit flags win over the config file.
  if (values.concurrency) suiteCfg.concurrency = concurrencies;
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
}

// ----------------------------------------------------------------- legacy --

let dataset: Dataset | null = null;
let totalPosts = 0;
if (legacyMode) {
  console.log(`generating dataset: ${userCount} users x ${postsPerUser} posts (seed ${seed})`);
  dataset = generate({ users: userCount, postsPerUser, seed });
  totalPosts = dataset.posts.length;
  console.log(`dataset ready: ${dataset.users.length} users, ${totalPosts} posts\n`);
}

const run: BenchmarkRun = {
  runId: newRunId(),
  startedAt: new Date().toISOString(),
  host: hostInfo(),
  config: {
    engines,
    workloads,
    contentions,
    concurrencies,
    durationSec: durationMs / 1000,
    warmupSec: warmupMs / 1000,
    repeats,
    users: userCount,
    postsPerUser,
    totalPosts,
    seed,
    scanLimit,
    // The fully-resolved suite config, so a suite run can be reproduced exactly.
    ...(suiteCfg ? { suite: suiteCfg, suiteTests: suiteSelection ? [...suiteSelection] : 'all' } : {}),
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

const failed = run.engines.filter((e) => e.integrity && e.integrity.mismatches > 0);
if (failed.length > 0) {
  console.error(
    `\nINTEGRITY FAILURE: ${failed.map((e) => e.displayName).join(', ')} — ` +
      'stored like counts disagree with the actual likes. These throughput ' +
      'numbers describe work that was not done atomically.',
  );
  process.exit(2);
}

async function benchmarkEngine(adapter: Adapter): Promise<EngineResult> {
  const version = await adapter.serverVersion();
  console.log(`connected: ${version}`);

  const result = legacyMode
    ? await benchmarkLegacy(adapter, version)
    : await emptyResult(adapter, version);

  if (suiteMode) {
    if (!adapter.suite) {
      console.log(`  ${adapter.displayName}: no suite implementation, skipping the suite`);
    } else {
      console.log('  running the suite');
      result.suite = await runSuite({
        adapter,
        cfg: suiteCfg!,
        selection: suiteSelection,
        log: (line) => console.log(line),
      });
    }
  }
  return result;
}

async function emptyResult(adapter: Adapter, version: string): Promise<EngineResult> {
  return {
    engine: adapter.engine,
    displayName: adapter.displayName,
    serverVersion: version,
    transactionality: adapter.capabilities.transactionality,
    memoryConfig: await adapter.memoryConfig().catch(() => ({})),
    loadMs: { users: 0, posts: 0 },
    cells: [],
    integrity: null,
    skippedWorkloads: [],
  };
}

async function benchmarkLegacy(adapter: Adapter, version: string): Promise<EngineResult> {
  const data = dataset!;

  await adapter.resetSchema();

  // Bulk load is timed separately from the measured workloads: it is a
  // throughput-of-ingest number, not a latency-under-concurrency number, and
  // conflating the two is what made the original results hard to interpret.
  const usersMs = await timed(async () => {
    for (const batch of chunk(data.users, 1000)) await adapter.insertUsers(batch);
  });
  const postsMs = await timed(async () => {
    for (const batch of chunk(data.posts, 1000)) await adapter.insertPosts(batch);
  });
  console.log(
    `loaded ${data.users.length} users in ${Math.round(usersMs)}ms, ` +
      `${totalPosts} posts in ${Math.round(postsMs)}ms`,
  );

  const cells: Cell[] = [];
  const skippedWorkloads: { workload: string; reason: string }[] = [];

  for (const workload of workloads) {
    if (adapter.capabilities.unsupportedWorkloads.includes(workload)) {
      const reason = `${adapter.displayName} cannot run this workload honestly (${adapter.capabilities.transactionality} transactionality)`;
      console.log(`  ${workload}: skipped — ${reason}`);
      skippedWorkloads.push({ workload, reason });
      continue;
    }
    const modes = workload === 'like-tx' ? contentions : [null];

    for (const mode of modes) {
      for (const concurrency of concurrencies) {
        const label = mode ? `${workload} (${mode})` : workload;
        process.stdout.write(`  ${label} @${concurrency} `);

        const runs: RunResult[] = [];
        for (let r = 0; r < repeats; r++) {
          const op =
            workload === 'like-tx'
              ? buildLikeOp({
                  adapter,
                  contention: mode === Contention.Hot ? Contention.Hot : Contention.Uniform,
                  totalUsers: data.users.length,
                  totalPosts,
                  concurrency,
                })
              : buildReadOp({
                  adapter,
                  workload: workload as ReadWorkload,
                  users: data.users,
                  concurrency,
                  limit: scanLimit,
                });

          runs.push(await runClosedLoop({ concurrency, durationMs, warmupMs, op }));
          process.stdout.write('.');
        }

        const throughputs = runs.map((r) => r.throughputPerSec);
        const med = median(throughputs);
        const representative = runs.reduce((best, r) =>
          Math.abs(r.throughputPerSec - med) < Math.abs(best.throughputPerSec - med) ? r : best,
        );

        cells.push({
          workload,
          contention: mode,
          concurrency,
          result: representative,
          throughputSpread:
            med > 0 ? (Math.max(...throughputs) - Math.min(...throughputs)) / med : 0,
        });

        console.log(
          ` ${Math.round(med)} ops/s  p99 ${representative.latencyMs.p99.toFixed(1)}ms` +
            (representative.errors ? `  errors ${representative.errors}` : ''),
        );
        if (representative.sampleErrors.length > 0) {
          console.log(`      ! ${representative.sampleErrors[0]}`);
        }
      }
    }
  }

  // Only check integrity if the like workload actually ran on this engine.
  const ranLikes = cells.some((c) => c.workload === 'like-tx');
  const integrity = ranLikes ? await adapter.verifyCounters() : null;

  return {
    engine: adapter.engine,
    displayName: adapter.displayName,
    serverVersion: version,
    transactionality: adapter.capabilities.transactionality,
    memoryConfig: await adapter.memoryConfig().catch(() => ({})),
    loadMs: { users: usersMs, posts: postsMs },
    cells,
    integrity,
    skippedWorkloads,
  };
}

async function timed(fn: () => Promise<void>): Promise<number> {
  const t0 = performance.now();
  await fn();
  return performance.now() - t0;
}

function skipped(engine: string, displayName: string, reason: string): EngineResult {
  return {
    engine,
    displayName,
    serverVersion: '—',
    transactionality: 'none',
    memoryConfig: {},
    loadMs: { users: 0, posts: 0 },
    cells: [],
    integrity: null,
    skippedWorkloads: [],
    skipped: reason,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
