/**
 * Result shape and rendering.
 *
 * JSON is the source of truth; console and markdown are rendered from it. The
 * old harness only ever produced a console.table dump pasted into the README,
 * which could not be diffed, re-aggregated or charted after the fact.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CounterCheck, Transactionality } from './adapter.ts';
import type { RunResult } from './runner.ts';
import type { HostInfo } from './runtime.ts';
import type { SuiteEngineResult } from '../suite/results.ts';
import { writeSuiteReports } from '../suite/report.ts';

export interface Cell {
  workload: string;
  contention: string | null;
  concurrency: number;
  /** Median over repeats. */
  result: RunResult;
  /** Spread across repeats, as a fraction of the median throughput. */
  throughputSpread: number;
}

export interface EngineResult {
  engine: string;
  displayName: string;
  serverVersion: string;
  transactionality: Transactionality;
  memoryConfig: Record<string, string>;
  loadMs: { users: number; posts: number };
  cells: Cell[];
  integrity: CounterCheck | null;
  /** Requested workloads this engine declined to run, with the reason. */
  skippedWorkloads: { workload: string; reason: string }[];
  /** Results of the write/read benchmark suite (features.md), when it ran. */
  suite?: SuiteEngineResult;
  skipped?: string;
}

export interface BenchmarkRun {
  runId: string;
  startedAt: string;
  host: HostInfo;
  config: Record<string, unknown>;
  engines: EngineResult[];
}

export function newRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
}

export async function writeResults(run: BenchmarkRun, outDir: string): Promise<string> {
  const dir = path.join(outDir, run.runId);
  await mkdir(dir, { recursive: true });

  const jsonPath = path.join(dir, 'result.json');
  await writeFile(jsonPath, JSON.stringify(run, null, 2), 'utf8');
  await writeFile(path.join(dir, 'result.md'), renderMarkdown(run), 'utf8');
  await writeSuiteReports(run, dir);

  return jsonPath;
}

const n = (v: number, digits = 2): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function renderMarkdown(run: BenchmarkRun): string {
  const out: string[] = [];

  out.push(`# Benchmark run ${run.runId}`);
  out.push('');
  out.push(
    `Runtime **${run.host.runtime} ${run.host.runtimeVersion}** on ` +
      `${run.host.platform}-${run.host.arch}, ` +
      `${run.host.cpuCount}x ${run.host.cpuModel}, ` +
      `${run.host.totalMemoryGB} GB RAM.`,
  );
  out.push('');
  out.push('```json');
  out.push(JSON.stringify(run.config, null, 2));
  out.push('```');
  out.push('');

  out.push('## Integrity');
  out.push('');
  out.push(
    'Every engine is checked after the like workload: each stored `like_count` ' +
      'is compared against an actual count of that post\'s likes. A non-zero ' +
      'mismatch means the transaction did not hold, and the throughput figures ' +
      'below describe work that was never done correctly.',
  );
  out.push('');
  out.push('| Engine | Version | Guarantee | Posts checked | Mismatches | Worst drift |');
  out.push('| --- | --- | --- | ---: | ---: | ---: |');
  for (const e of run.engines) {
    if (e.skipped) {
      out.push(`| ${e.displayName} | — | — | — | _skipped: ${e.skipped}_ | — |`);
      continue;
    }
    const i = e.integrity;
    if (!i) {
      out.push(
        `| ${e.displayName} | ${e.serverVersion} | ${e.transactionality} | — | _n/a: like-tx not run_ | — |`,
      );
      continue;
    }
    const flag = i.mismatches > 0 ? ' ⚠️' : '';
    out.push(
      `| ${e.displayName} | ${e.serverVersion} | ${e.transactionality} | ` +
        `${i.postsChecked} | ${i.mismatches}${flag} | ${i.worstDrift} |`,
    );
  }
  out.push('');

  const skippedAny = run.engines.filter((e) => !e.skipped && e.skippedWorkloads.length > 0);
  if (skippedAny.length > 0) {
    out.push('## Workloads not run');
    out.push('');
    for (const e of skippedAny) {
      for (const s of e.skippedWorkloads) {
        out.push(`- **${e.displayName}** — \`${s.workload}\`: ${s.reason}`);
      }
    }
    out.push('');
  }

  out.push('## Memory configuration');
  out.push('');
  out.push(
    'Published because a benchmark that does not state its cache budget is not ' +
      'reproducible. These engines do not agree on defaults: Postgres and MySQL ' +
      'both sit at a hardcoded 128MB regardless of the container limit, while ' +
      'MongoDB sizes WiredTiger from the cgroup. Leaving them alone measures ' +
      'that asymmetry rather than the databases.',
  );
  out.push('');
  for (const e of run.engines) {
    if (e.skipped) continue;
    const pairs = Object.entries(e.memoryConfig).map(([k, v]) => `${k}=${v}`);
    out.push(`- **${e.displayName}**: ${pairs.join(', ') || '—'}`);
  }
  out.push('');

  const workloads = [...new Set(run.engines.flatMap((e) => e.cells.map(cellKey)))];

  for (const key of workloads) {
    out.push(`## ${key}`);
    out.push('');
    out.push('| Engine | Conc | ops/sec | p50 ms | p95 ms | p99 ms | max ms | errors | retries | conflicts |');
    out.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const e of run.engines) {
      for (const c of e.cells.filter((c) => cellKey(c) === key)) {
        const r = c.result;
        out.push(
          `| ${e.displayName} | ${c.concurrency} | ${n(r.throughputPerSec, 0)} | ` +
            `${n(r.latencyMs.p50)} | ${n(r.latencyMs.p95)} | ${n(r.latencyMs.p99)} | ` +
            `${n(r.latencyMs.max)} | ${r.errors} | ${r.retries} | ${r.conflicts} |`,
        );
      }
    }
    out.push('');
  }

  out.push('## Caveats');
  out.push('');
  out.push(
    '- The load generator is a **closed loop**: a fixed number of workers each ' +
      'run operations sequentially. This understates latency under overload ' +
      '(coordinated omission), so these numbers are comparative between engines, ' +
      'not absolute service-level figures.',
  );
  out.push(
    '- MongoDB runs as a **single-node replica set**, so `w:majority` is ' +
      'satisfied by one node and it pays no replication cost here.',
  );
  out.push(
    '- MySQL is pinned to `READ-COMMITTED` to match Postgres\' default. At its ' +
      'own default of `REPEATABLE READ` the `likes` insert takes gap locks and ' +
      'the comparison would measure isolation level, not engine.',
  );
  out.push('');

  return out.join('\n');
}

function cellKey(c: Cell): string {
  return c.contention ? `${c.workload} (${c.contention} contention)` : c.workload;
}

export function renderConsole(run: BenchmarkRun): void {
  for (const e of run.engines) {
    if (e.skipped) {
      console.log(`\n${e.displayName}: skipped — ${e.skipped}`);
      continue;
    }
    console.log(`\n=== ${e.displayName} ${e.serverVersion} (${e.transactionality}) ===`);
    for (const s of e.skippedWorkloads) console.log(`not run: ${s.workload} — ${s.reason}`);
    const table = Object.fromEntries(
      e.cells.map((c) => [
        `${cellKey(c)} @${c.concurrency}`,
        {
          'ops/sec': Math.round(c.result.throughputPerSec),
          p50: Number(c.result.latencyMs.p50.toFixed(2)),
          p95: Number(c.result.latencyMs.p95.toFixed(2)),
          p99: Number(c.result.latencyMs.p99.toFixed(2)),
          errors: c.result.errors,
          retries: c.result.retries,
        },
      ]),
    );
    if (e.cells.length > 0) console.table(table);
    if (e.suite) {
      const counts: Record<string, number> = {};
      for (const c of e.suite.cells) counts[c.status] = (counts[c.status] ?? 0) + 1;
      console.log(
        'suite: ' +
          Object.entries(counts)
            .map(([status, count]) => `${count} ${status}`)
            .join(', '),
      );
    }
    if (e.integrity) {
      const { mismatches, postsChecked, worstDrift } = e.integrity;
      const verdict = mismatches === 0 ? 'OK' : `FAILED (worst drift ${worstDrift})`;
      console.log(`integrity: ${verdict} — ${mismatches}/${postsChecked} posts mismatched`);
    }
  }
}
