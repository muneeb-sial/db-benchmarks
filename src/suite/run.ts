/**
 * Runs the suite against one engine: seed, then execute every cell at every
 * concurrency level, capturing EXPLAIN and index build costs on the way.
 */

import type { Adapter } from '../core/adapter.ts';
import { median, summarize } from '../core/stats.ts';
import type { SuiteConfig } from './config.ts';
import { docRow, likeRow, makePlan, postRow, userRow, type DataPlan } from './data.ts';
import {
  queryKey,
  type CellStatus,
  type IndexBuild,
  type SuiteCellResult,
  type SuiteEngineResult,
  type TraversalResult,
} from './results.ts';
import { runFixed, runTimed, runTraversal, type Measure } from './runner.ts';
import type { SuiteRow, SuiteTable } from './schema.ts';
import type { ExplainOut, IndexKind } from './specs.ts';
import { buildCells, type TestCell } from './tests.ts';

export interface SuiteRunOptions {
  adapter: Adapter;
  cfg: SuiteConfig;
  /** Test ids to run; null means all. */
  selection: Set<string> | null;
  log: (line: string) => void;
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export function describeCell(c: TestCell): string {
  const parts: string[] = [c.id];
  if (c.shape) parts.push(c.shape);
  if (c.mode) parts.push(c.mode);
  if (c.limit !== null) parts.push(String(c.limit));
  if (c.variant) parts.push(c.variant);
  return parts.join(' / ');
}

export async function runSuite(o: SuiteRunOptions): Promise<SuiteEngineResult> {
  const suite = o.adapter.suite;
  const { cfg, log } = o;

  const plan = makePlan(cfg);
  const cells = buildCells({ suite, cfg, plan }, o.selection);
  const runnable = cells.filter((c) => suite.support(c.feature).ok);

  // ---------------------------------------------------------------- setup --
  const needed = new Set<SuiteTable>();
  for (const c of runnable) for (const t of c.needs) needed.add(t);
  const needsSeed = runnable.some((c) => c.feature.kind !== 'write');
  const needsDocuments =
    needed.has('documents') || runnable.some((c) => c.feature.kind === 'write' && c.feature.test === 'w4');

  log(`  preparing schema (${cfg.dataset.tablePrefix}* tables)`);
  await suite.resetSchema(cfg, { documents: needsDocuments });

  const loadMs: Record<string, number> = {};
  const seed = async (
    table: SuiteTable,
    count: number,
    make: (p: DataPlan, id: number) => SuiteRow,
  ): Promise<void> => {
    const t0 = performance.now();
    const chunk = cfg.dataset.loadChunk;
    for (let start = 1; start <= count; start += chunk) {
      const end = Math.min(count, start + chunk - 1);
      const rows: SuiteRow[] = [];
      for (let id = start; id <= end; id++) rows.push(make(plan, id));
      await suite.bulkInsert(table, rows);
    }
    loadMs[table] = performance.now() - t0;
    log(`  loaded ${count.toLocaleString('en-US')} ${table} in ${Math.round(loadMs[table]!)}ms`);
  };

  if (needsSeed) {
    await seed('users', plan.users, userRow);
    if (needed.has('posts')) await seed('posts', plan.posts, postRow);
    if (needed.has('likes')) await seed('likes', plan.likes, likeRow);
    if (needed.has('documents')) await seed('documents', plan.documents, docRow);
  }
  await suite.afterLoad();

  // ------------------------------------------------------------- estimate --
  let runs = 0;
  let timedSeconds = 0;
  for (const c of runnable) {
    for (const conc of cfg.concurrency) {
      runs++;
      if (c.runner(conc).kind === 'timed') {
        timedSeconds += (cfg.run.durationSec + cfg.run.warmupSec) * cfg.run.repeats;
      }
    }
  }
  log(
    `  ${cells.length} cells (${cells.length - runnable.length} not applicable), ${runs} runs; ` +
      `timed cells alone take about ${Math.ceil(timedSeconds / 60)} min`,
  );

  // ------------------------------------------------------------ execution --
  const results: SuiteCellResult[] = [];
  const explain: Record<string, ExplainOut> = {};
  const indexes: IndexBuild[] = [];
  const traversals: TraversalResult[] = [];
  let activeIndex: IndexKind | null = null;

  const ensureIndex = async (kind: IndexKind | null): Promise<void> => {
    if (activeIndex && activeIndex !== kind) {
      await suite.dropIndex(activeIndex).catch(() => {});
      activeIndex = null;
    }
    if (kind && activeIndex !== kind) {
      const t0 = performance.now();
      await suite.createIndex(kind);
      const buildMs = performance.now() - t0;
      const sizeBytes = await suite.indexSizeBytes(kind).catch(() => null);
      indexes.push({ kind, buildMs, sizeBytes });
      log(`  built index ${kind} in ${Math.round(buildMs)}ms`);
      activeIndex = kind;
    }
  };

  const blank = (
    cell: TestCell,
    key: string,
    concurrency: number,
    status: CellStatus,
    reason: string,
  ): SuiteCellResult => ({
    test: cell.id,
    group: cell.group,
    title: cell.title,
    shape: cell.shape,
    mode: cell.mode,
    limit: cell.limit,
    variant: cell.variant,
    concurrency,
    status,
    reason,
    ops: 0,
    wallMs: 0,
    opsPerSec: 0,
    rowsPerSec: 0,
    rowsPerQuery: 0,
    latencyMs: null,
    errors: 0,
    ukViolations: 0,
    sampleErrors: [],
    queryKey: key,
  });

  const measured = (cell: TestCell, key: string, concurrency: number, m: Measure): SuiteCellResult => {
    const seconds = m.wallMs / 1000;
    return {
      ...blank(cell, key, concurrency, 'ok', ''),
      reason: '',
      ops: m.ops,
      wallMs: m.wallMs,
      opsPerSec: m.ops / seconds,
      rowsPerSec: m.rows / seconds,
      rowsPerQuery: m.ops > 0 ? m.rows / m.ops : 0,
      latencyMs: m.latency,
      errors: m.errors,
      ukViolations: m.ukViolations,
      sampleErrors: m.sampleErrors,
    };
  };

  const runCell = async (cell: TestCell, key: string, concurrency: number): Promise<SuiteCellResult> => {
    const runner = cell.runner(concurrency);
    const isUniqueViolation = (e: unknown): boolean => suite.isUniqueViolation(e);

    if (runner.kind === 'timed') {
      const runs: Measure[] = [];
      for (let r = 0; r < cfg.run.repeats; r++) {
        runs.push(
          await runTimed({
            concurrency,
            durationMs: cfg.run.durationSec * 1000,
            warmupMs: cfg.run.warmupSec * 1000,
            op: runner.op,
            isUniqueViolation,
          }),
        );
      }
      // Report the run whose throughput is closest to the median.
      const throughput = (m: Measure): number => m.ops / (m.wallMs / 1000);
      const med = median(runs.map(throughput));
      const pick = runs.reduce((best, m) =>
        Math.abs(throughput(m) - med) < Math.abs(throughput(best) - med) ? m : best,
      );
      return measured(cell, key, concurrency, pick);
    }

    if (runner.kind === 'fixed') {
      if (runner.prepare) await runner.prepare();
      const m = await runFixed({ concurrency, totalOps: runner.totalOps, op: runner.op, isUniqueViolation });
      return measured(cell, key, concurrency, m);
    }

    const t = await runTraversal({ concurrency, walk: runner.walk });
    traversals.push({
      test: cell.id,
      shape: cell.shape ?? '-',
      mode: cell.mode ?? '-',
      pageSize: runner.pageSize,
      concurrency,
      pages: t.pages,
      rows: t.rows,
      totalMs: t.totalMs,
      perPageMs: t.perPageMs,
    });
    const latency = Float64Array.from(t.allPageMs);
    return measured(cell, key, concurrency, {
      ops: latency.length,
      wallMs: t.wallMs,
      rows: t.rows * concurrency,
      latency: summarize(latency, latency.length),
      errors: t.errors,
      ukViolations: 0,
      sampleErrors: t.sampleErrors,
    });
  };

  for (const cell of cells) {
    const key = queryKey(cell.id, cell.shape, cell.mode, cell.limit, cell.variant);
    const label = describeCell(cell);

    const support = suite.support(cell.feature);
    if (!support.ok) {
      log(`  ${label}: N/A — ${support.reason}`);
      for (const c of cfg.concurrency) results.push(blank(cell, key, c, 'na', support.reason));
      continue;
    }

    try {
      if (cell.needsIndex !== undefined) await ensureIndex(cell.needsIndex);
    } catch (err) {
      const reason = `index setup failed: ${message(err)}`;
      log(`  ${label}: ${reason}`);
      for (const c of cfg.concurrency) results.push(blank(cell, key, c, 'error', reason));
      continue;
    }

    if (cell.explainQuery && !(key in explain)) {
      explain[key] = await suite
        .explain(cell.explainQuery)
        .catch((err: unknown): ExplainOut => ({ text: `explain failed: ${message(err)}`, indexUsed: null }));
    }

    for (const c of cfg.concurrency) {
      const inFlight = cell.inFlightRows(c);
      if (inFlight > cfg.guards.maxInFlightRows) {
        const reason =
          `would hold ${inFlight.toLocaleString('en-US')} rows in flight, over ` +
          `guards.maxInFlightRows (${cfg.guards.maxInFlightRows.toLocaleString('en-US')})`;
        log(`  ${label} @${c}: skipped — ${reason}`);
        results.push(blank(cell, key, c, 'skipped', reason));
        continue;
      }

      try {
        const r = await runCell(cell, key, c);
        results.push(r);
        log(
          `  ${label} @${c}  ${Math.round(r.opsPerSec).toLocaleString('en-US')} ops/s` +
            `  p95 ${(r.latencyMs?.p95 ?? 0).toFixed(1)}ms  rows/op ${r.rowsPerQuery.toFixed(0)}` +
            (r.errors ? `  errors ${r.errors}${r.ukViolations ? ` (uk ${r.ukViolations})` : ''}` : ''),
        );
        if (r.sampleErrors[0]) log(`      ! ${r.sampleErrors[0]}`);
      } catch (err) {
        log(`  ${label} @${c}: error — ${message(err)}`);
        results.push(blank(cell, key, c, 'error', message(err)));
      }
    }
  }

  // Assigned inside closures, so widen it back before the final cleanup.
  const leftover = activeIndex as IndexKind | null;
  if (leftover) await suite.dropIndex(leftover).catch(() => {});

  return { loadMs, cells: results, explain, indexes, traversals };
}
