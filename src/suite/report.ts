/**
 * Suite output, written next to result.json:
 *
 *   tables/<engine>.md          one table per test id, concurrency as columns
 *   explain/<engine>.md         the query plan captured for each distinct query
 *   charts/r4-<engine>-<shape>.svg   R4 per-page latency, offset vs cursor
 *   summary.md                  one comparison across engines
 *
 * Charts are plain SVG built here, so there is no charting dependency.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { BenchmarkRun, EngineResult } from '../core/reporter.ts';
import type { SuiteConfig } from './config.ts';
import type { SuiteCellResult, TraversalResult } from './results.ts';

const n = (v: number, digits = 2): string =>
  v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });

export function caseLabel(c: {
  shape: string | null;
  mode: string | null;
  limit: number | null;
  variant: string | null;
}): string {
  const parts: string[] = [];
  if (c.shape) parts.push(c.shape);
  if (c.mode) parts.push(c.mode);
  if (c.limit !== null) parts.push(c.limit.toLocaleString('en-US'));
  if (c.variant) parts.push(c.variant);
  return parts.length > 0 ? parts.join(' / ') : 'default';
}

function cellText(c: SuiteCellResult | undefined): string {
  if (!c) return '—';
  if (c.status === 'na') return 'N/A';
  if (c.status === 'skipped') return 'skipped';
  if (c.status === 'error') return 'error';
  const p95 = c.latencyMs?.p95 ?? 0;
  return (
    `${n(c.opsPerSec, 0)} ops/s · p95 ${n(p95)} ms · ${n(c.rowsPerQuery, 0)} rows` +
    (c.errors > 0 ? ` · ${c.errors} err` : '')
  );
}

/** One markdown document per engine: a table per test id, concurrency as columns. */
export function renderEngineTables(engine: EngineResult): string {
  const suite = engine.suite;
  if (!suite) return '';

  const concurrencies = [...new Set(suite.cells.map((c) => c.concurrency))].sort((a, b) => a - b);
  const out: string[] = [];

  out.push(`# ${engine.displayName} ${engine.serverVersion} — suite results`);
  out.push('');
  out.push('Load times: ' + Object.entries(suite.loadMs).map(([t, ms]) => `${t} ${Math.round(ms)}ms`).join(', '));
  out.push('');

  if (suite.indexes.length > 0) {
    out.push('## Index builds');
    out.push('');
    out.push('| Index | Build time | Size |');
    out.push('| --- | ---: | ---: |');
    for (const ix of suite.indexes) {
      const size = ix.sizeBytes === null ? '—' : `${n(ix.sizeBytes / 1024 / 1024)} MiB`;
      out.push(`| ${ix.kind} | ${n(ix.buildMs, 0)} ms | ${size} |`);
    }
    out.push('');
  }

  const byTest = new Map<string, SuiteCellResult[]>();
  for (const c of suite.cells) {
    const list = byTest.get(c.test) ?? [];
    list.push(c);
    byTest.set(c.test, list);
  }

  for (const [test, cells] of byTest) {
    out.push(`## ${test.toUpperCase()}. ${cells[0]!.title}`);
    out.push('');

    const rows = new Map<string, Map<number, SuiteCellResult>>();
    for (const c of cells) {
      const label = caseLabel(c);
      const row = rows.get(label) ?? new Map<number, SuiteCellResult>();
      row.set(c.concurrency, c);
      rows.set(label, row);
    }

    out.push(`| Case | ${concurrencies.map((c) => `c=${c}`).join(' | ')} |`);
    out.push(`| --- | ${concurrencies.map(() => '---').join(' | ')} |`);
    for (const [label, row] of rows) {
      out.push(`| ${label} | ${concurrencies.map((c) => cellText(row.get(c))).join(' | ')} |`);
    }
    out.push('');

    // Why something is N/A, skipped or errored, once per case.
    const notes: string[] = [];
    for (const [label, row] of rows) {
      const bad = [...row.values()].find((c) => c.status !== 'ok' && c.reason);
      if (bad) notes.push(`- **${label}** — ${bad.status}: ${bad.reason}`);
    }
    if (notes.length > 0) {
      out.push(...notes);
      out.push('');
    }
  }

  const traversals = suite.traversals;
  if (traversals.length > 0) {
    out.push('## R4 traversal totals');
    out.push('');
    out.push('| Shape | Mode | Page size | Conc | Pages | Total time |');
    out.push('| --- | --- | ---: | ---: | ---: | ---: |');
    for (const t of traversals) {
      out.push(`| ${t.shape} | ${t.mode} | ${t.pageSize.toLocaleString('en-US')} | ${t.concurrency} | ${t.pages} | ${n(t.totalMs, 0)} ms |`);
    }
    out.push('');
  }

  return out.join('\n');
}

export function renderExplain(engine: EngineResult): string {
  const suite = engine.suite;
  if (!suite) return '';
  const out: string[] = [`# ${engine.displayName} — query plans`, ''];
  out.push(
    'Captured once per distinct query. "index used" is a best-effort reading of the plan text, ' +
      'so read the plan itself before trusting it.',
  );
  out.push('');
  for (const [key, plan] of Object.entries(suite.explain)) {
    const flag = plan.indexUsed === null ? 'unknown' : plan.indexUsed ? 'yes' : 'no';
    out.push(`## ${key}`);
    out.push('');
    out.push(`index used: **${flag}**`);
    out.push('');
    out.push('```');
    out.push(plan.text);
    out.push('```');
    out.push('');
  }
  return out.join('\n');
}

// ------------------------------------------------------------------ charts --

interface Series {
  label: string;
  color: string;
  dash?: string;
  points: number[];
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function svgLineChart(title: string, subtitle: string, series: Series[]): string {
  const W = 760;
  const H = 340;
  const L = 64;
  const R = 24;
  const T = 60;
  const B = 52;

  const longest = Math.max(1, ...series.map((s) => s.points.length));
  const peak = Math.max(1e-6, ...series.flatMap((s) => s.points)) * 1.08;

  const x = (i: number): number => L + (i / Math.max(1, longest - 1)) * (W - L - R);
  const y = (v: number): number => T + (1 - v / peak) * (H - T - B);

  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" font-family="system-ui, sans-serif">`,
  );
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="${L}" y="24" font-size="15" font-weight="600" fill="#1a1a1a">${esc(title)}</text>`);
  out.push(`<text x="${L}" y="42" font-size="11" fill="#666666">${esc(subtitle)}</text>`);

  for (let k = 0; k <= 4; k++) {
    const v = (peak / 4) * k;
    const yy = y(v);
    out.push(`<line x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}" stroke="#e6e6e6"/>`);
    out.push(`<text x="${L - 8}" y="${yy + 4}" font-size="10" text-anchor="end" fill="#555555">${n(v, v < 10 ? 1 : 0)}</text>`);
  }
  for (let k = 0; k <= 4; k++) {
    const i = Math.round(((longest - 1) / 4) * k);
    out.push(`<text x="${x(i)}" y="${H - B + 16}" font-size="10" text-anchor="middle" fill="#555555">${i + 1}</text>`);
  }
  out.push(`<text x="${(L + W - R) / 2}" y="${H - 10}" font-size="11" text-anchor="middle" fill="#333333">page number</text>`);
  out.push(`<text x="14" y="${(T + H - B) / 2}" font-size="11" text-anchor="middle" fill="#333333" transform="rotate(-90 14 ${(T + H - B) / 2})">latency (ms)</text>`);

  series.forEach((s, idx) => {
    // Long traversals are averaged into buckets so the file stays small.
    const step = Math.max(1, Math.ceil(s.points.length / 600));
    const coords: string[] = [];
    for (let i = 0; i < s.points.length; i += step) {
      const slice = s.points.slice(i, i + step);
      const v = slice.reduce((a, b) => a + b, 0) / slice.length;
      coords.push(`${x(i).toFixed(1)},${y(v).toFixed(1)}`);
    }
    if (coords.length === 0) return;
    out.push(
      `<polyline fill="none" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''} points="${coords.join(' ')}"/>`,
    );
    const lx = L + idx * 150;
    out.push(`<line x1="${lx}" x2="${lx + 22}" y1="${H - 30}" y2="${H - 30}" stroke="${s.color}" stroke-width="2"${s.dash ? ` stroke-dasharray="${s.dash}"` : ''}/>`);
    out.push(`<text x="${lx + 28}" y="${H - 26}" font-size="11" fill="#333333">${esc(s.label)}</text>`);
  });

  out.push('</svg>');
  return out.join('\n');
}

const nearest = (values: number[], target: number): number =>
  values.reduce((best, v) => (Math.abs(v - target) < Math.abs(best - target) ? v : best), values[0]!);

/** Offset vs cursor per-page latency for one engine and shape, or null if R4 did not run. */
export function renderR4Chart(engine: EngineResult, shape: string, cfg: SuiteConfig): string | null {
  const all = (engine.suite?.traversals ?? []).filter((t) => t.test === 'r4' && t.shape === shape);
  if (all.length === 0) return null;

  const concurrency = nearest([...new Set(all.map((t) => t.concurrency))], cfg.reports.r4Chart.concurrency);
  const atConc = all.filter((t) => t.concurrency === concurrency);
  const pageSize = nearest([...new Set(atConc.map((t) => t.pageSize))], cfg.reports.r4Chart.pageSize);

  const pick = (mode: string): TraversalResult | undefined =>
    atConc.find((t) => t.mode === mode && t.pageSize === pageSize);
  const offset = pick('offset');
  const cursor = pick('cursor');

  const series: Series[] = [];
  if (offset) series.push({ label: 'offset pagination', color: '#c0392b', points: offset.perPageMs });
  if (cursor) series.push({ label: 'cursor pagination', color: '#1f7a8c', dash: '6 4', points: cursor.perPageMs });
  if (series.length === 0) return null;

  return svgLineChart(
    `${engine.displayName}: R4 full traversal, ${shape}`,
    `page size ${pageSize.toLocaleString('en-US')}, concurrency ${concurrency}, median latency per page across workers`,
    series,
  );
}

// ----------------------------------------------------------------- summary --

/** One table per test id comparing every engine at a single reference concurrency. */
export function renderSummary(run: BenchmarkRun, cfg: SuiteConfig | undefined): string {
  const engines = run.engines.filter((e) => e.suite && !e.skipped);
  const out: string[] = ['# Suite comparison', ''];

  const allConc = [...new Set(engines.flatMap((e) => e.suite!.cells.map((c) => c.concurrency)))];
  if (allConc.length === 0) return out.join('\n');
  const ref = nearest(allConc, cfg?.reports.summaryConcurrency ?? 8);

  out.push(
    `Throughput (ops/sec) at concurrency **${ref}**. The best engine per row is bold; ` +
      'N/A means the engine cannot run that case honestly (reasons are in tables/).',
  );
  out.push('');

  const testIds: string[] = [];
  for (const e of engines) for (const c of e.suite!.cells) if (!testIds.includes(c.test)) testIds.push(c.test);

  for (const test of testIds) {
    const labels: string[] = [];
    let title = '';
    for (const e of engines) {
      for (const c of e.suite!.cells) {
        if (c.test !== test || c.concurrency !== ref) continue;
        title = c.title;
        const label = caseLabel(c);
        if (!labels.includes(label)) labels.push(label);
      }
    }

    out.push(`## ${test.toUpperCase()}. ${title}`);
    out.push('');
    out.push(`| Case | ${engines.map((e) => e.displayName).join(' | ')} |`);
    out.push(`| --- | ${engines.map(() => '---:').join(' | ')} |`);

    for (const label of labels) {
      const found = engines.map((e) =>
        e.suite!.cells.find((c) => c.test === test && c.concurrency === ref && caseLabel(c) === label),
      );
      const best = Math.max(0, ...found.map((c) => (c?.status === 'ok' ? c.opsPerSec : 0)));
      const cols = found.map((c) => {
        if (!c) return '—';
        if (c.status !== 'ok') return c.status === 'na' ? 'N/A' : c.status;
        const text = n(c.opsPerSec, 0);
        return c.opsPerSec === best && best > 0 ? `**${text}**` : text;
      });
      out.push(`| ${label} | ${cols.join(' | ')} |`);
    }
    out.push('');
  }

  return out.join('\n');
}

export async function writeSuiteReports(run: BenchmarkRun, dir: string): Promise<void> {
  const engines = run.engines.filter((e) => e.suite && !e.skipped);
  if (engines.length === 0) return;

  const cfg = run.config.suite as SuiteConfig | undefined;

  await mkdir(path.join(dir, 'tables'), { recursive: true });
  await mkdir(path.join(dir, 'explain'), { recursive: true });
  await mkdir(path.join(dir, 'charts'), { recursive: true });

  for (const e of engines) {
    await writeFile(path.join(dir, 'tables', `${e.engine}.md`), renderEngineTables(e), 'utf8');
    await writeFile(path.join(dir, 'explain', `${e.engine}.md`), renderExplain(e), 'utf8');

    if (cfg) {
      for (const shape of ['simple', 'single-join', 'multi-join']) {
        const svg = renderR4Chart(e, shape, cfg);
        if (svg) await writeFile(path.join(dir, 'charts', `r4-${e.engine}-${shape}.svg`), svg, 'utf8');
      }
    }
  }

  await writeFile(path.join(dir, 'summary.md'), renderSummary(run, cfg), 'utf8');
}
