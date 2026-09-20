/**
 * Benchmark entry point. Runs identically under Node and Bun. Deno is unsupported.
 *
 *   node src/cli.ts --db postgres --workload like-tx --duration 10
 *   bun  src/cli.ts --db postgres,mysql --concurrency 1,8,32
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
import { chunk, generate } from './dataset/generate.ts';
import { buildLikeOp, Contention } from './workloads/like-tx.ts';
import { buildReadOp, ReadWorkload } from './workloads/read.ts';
import type { Adapter } from './core/adapter.ts';

assertSupportedRuntime();

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: ENGINE_NAMES.join(',') },
    workload: { type: 'string', default: 'like-tx' },
    contention: { type: 'string', default: 'uniform,hot' },
    concurrency: { type: 'string', default: '1,8,32,64' },
    duration: { type: 'string', default: '10' },
    warmup: { type: 'string', default: '3' },
    repeats: { type: 'string', default: '3' },
    users: { type: 'string', default: '20000' },
    'posts-per-user': { type: 'string', default: '2' },
    limit: { type: 'string', default: '1000' },
    seed: { type: 'string', default: '42' },
    out: { type: 'string', default: 'results' },
    host: { type: 'string' },
    port: { type: 'string' },
    help: { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: false,
});

if (values.help) {
  console.log(`
db-benchmarks — transactional benchmarks across Postgres, MySQL, MongoDB and CockroachDB

  --db            comma list: ${ENGINE_NAMES.join(', ')}      (default: all)
  --workload      comma list: like-tx, ${Object.values(ReadWorkload).join(', ')}
  --contention    comma list: uniform, hot                    (like-tx only)
  --concurrency   comma list of in-flight levels              (default: 1,8,32,64)
  --duration      measured seconds per cell                   (default: 10)
  --warmup        discarded seconds per cell                  (default: 3)
  --repeats       repetitions per cell, median reported       (default: 3)
  --users         users to generate                           (default: 20000)
  --posts-per-user                                            (default: 2)
  --limit         row limit for scan workloads                (default: 1000)
  --seed          dataset seed                                (default: 42)
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

const engines = list(values.db!);
const workloads = list(values.workload!);
const contentions = list(values.contention!);
const concurrencies = list(values.concurrency!).map((c) => num(c, 1));
const durationMs = num(values.duration, 10) * 1000;
const warmupMs = num(values.warmup, 3) * 1000;
const repeats = num(values.repeats, 3);
const userCount = num(values.users, 20000);
const postsPerUser = num(values['posts-per-user'], 2);
const scanLimit = num(values.limit, 1000);
const seed = num(values.seed, 42);

const runtime = detectRuntime();

console.log(`runtime: ${runtime} ${hostInfo().runtimeVersion}`);
console.log(`generating dataset: ${userCount} users x ${postsPerUser} posts (seed ${seed})`);

const dataset = generate({ users: userCount, postsPerUser, seed });
const totalPosts = dataset.posts.length;
console.log(`dataset ready: ${dataset.users.length} users, ${totalPosts} posts\n`);

const run: BenchmarkRun = {
  runId: newRunId(),
  startedAt: new Date().toISOString(),
  host: hostInfo(),
  config: {
    engines, workloads, contentions, concurrencies,
    durationSec: durationMs / 1000,
    warmupSec: warmupMs / 1000,
    repeats, users: userCount, postsPerUser, totalPosts, seed, scanLimit,
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

  await adapter.resetSchema();

  // Bulk load is timed separately from the measured workloads: it is a
  // throughput-of-ingest number, not a latency-under-concurrency number, and
  // conflating the two is what made the original results hard to interpret.
  const usersMs = await timed(async () => {
    for (const batch of chunk(dataset.users, 1000)) await adapter.insertUsers(batch);
  });
  const postsMs = await timed(async () => {
    for (const batch of chunk(dataset.posts, 1000)) await adapter.insertPosts(batch);
  });
  console.log(
    `loaded ${dataset.users.length} users in ${Math.round(usersMs)}ms, ` +
      `${totalPosts} posts in ${Math.round(postsMs)}ms`,
  );

  const cells: Cell[] = [];

  for (const workload of workloads) {
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
                  totalUsers: dataset.users.length,
                  totalPosts,
                  concurrency,
                })
              : buildReadOp({
                  adapter,
                  workload: workload as ReadWorkload,
                  users: dataset.users,
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

  const integrity = workloads.includes('like-tx') ? await adapter.verifyCounters() : null;

  return {
    engine: adapter.engine,
    displayName: adapter.displayName,
    serverVersion: version,
    transactionality: adapter.capabilities.transactionality,
    memoryConfig: await adapter.memoryConfig().catch(() => ({})),
    loadMs: { users: usersMs, posts: postsMs },
    cells,
    integrity,
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
    skipped: reason,
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
