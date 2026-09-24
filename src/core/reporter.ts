/**
 * Result shape and rendering.
 *
 * JSON is the source of truth; console and markdown are rendered from it. The
 * suite's per-test tables, EXPLAIN plans and charts are written alongside it by
 * src/suite/report.ts.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeSuiteReports } from '../suite/report.ts';
import type { BenchmarkRun } from '../types/reporter.type.ts';

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

  out.push('## Engines');
  out.push('');
  for (const e of run.engines) {
    out.push(
      e.skipped
        ? `- **${e.displayName}**: _skipped: ${e.skipped}_`
        : `- **${e.displayName}** ${e.serverVersion}`,
    );
  }
  out.push('');

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

  out.push('## Caveats');
  out.push('');
  out.push(
    '- The load generator is a **closed loop**: a fixed number of workers each ' +
      'run operations sequentially. This understates latency under overload ' +
      '(coordinated omission), so these numbers are comparative between engines, ' +
      'not absolute service-level figures.',
  );
  out.push('');

  return out.join('\n');
}

export function renderConsole(run: BenchmarkRun): void {
  for (const e of run.engines) {
    if (e.skipped) {
      console.log(`\n${e.displayName}: skipped — ${e.skipped}`);
      continue;
    }
    console.log(`\n=== ${e.displayName} ${e.serverVersion} ===`);
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
  }
}
