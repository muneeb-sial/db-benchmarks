/**
 * Results page: every run under results/ (GET /api/runs), and one run in full
 * (GET /api/runs/:id): what was asked, how each database was set up, every
 * cell's numbers, what was skipped and why, and any file in the run folder.
 * The selected run and file live in the URL hash, so a view can be linked.
 */

import type { Compact, Stats } from '../suite/events.ts';

interface Outcome {
  db: string;
  cell: string;
  vus?: number;
  status: 'ok' | 'na' | 'failed';
  reason?: string;
  compact?: Compact;
}

interface RunItem {
  id: string;
  startedAt: string | null;
  updatedAt: string;
  complete: boolean;
  profile: string | null;
  dbs: string[];
  tests: string[];
  concurrency: number[];
  durationSec: number | null;
  counts: { ok: number; na: number; failed: number };
  files: number;
  bytes: number;
}

interface RunDetail extends RunItem {
  run: { request?: Record<string, unknown>; config?: Record<string, unknown> } | null;
  outcomes: Outcome[];
  initialize: Record<string, InitResult>;
  summary: string | null;
  tree: { path: string; bytes: number }[];
}

interface InitResult {
  container?: { downMs?: number; upMs?: number; output?: string };
  loadMs?: Record<string, number>;
  indexMs?: Record<string, number>;
  indexes?: string[];
  manifest?: Record<string, unknown>;
}

type Metric = 'rate' | 'http50' | 'http95' | 'http99' | 'db50' | 'db95' | 'db99';

/** Comparable columns: how to read them from a compact summary, and which way is better. */
const METRICS: Record<Metric, { label: string; get: (c: Compact) => number | undefined; higher: boolean }> = {
  rate: { label: 'req/s', get: (c) => c.reqs?.rate, higher: true },
  http50: { label: 'http p50', get: (c) => c.http_req_duration?.med, higher: false },
  http95: { label: 'http p95', get: (c) => c.http_req_duration?.['p(95)'], higher: false },
  http99: { label: 'http p99', get: (c) => c.http_req_duration?.['p(99)'], higher: false },
  db50: { label: 'db p50', get: (c) => c.db_ms?.med, higher: false },
  db95: { label: 'db p95', get: (c) => c.db_ms?.['p(95)'], higher: false },
  db99: { label: 'db p99', get: (c) => c.db_ms?.['p(99)'], higher: false },
};
const TABLE_METRICS: Metric[] = ['rate', 'http50', 'http95', 'http99', 'db50', 'db95', 'db99'];
const BAR_WIDTH = 28;

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const esc = (s: unknown): string =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const num = (v: number | undefined | null, digits = 2): string =>
  v === undefined || v === null ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10 ** digits) / 10 ** digits);

const ms = (v: number | undefined): string => {
  if (v === undefined) return '–';
  if (v < 1000) return `${num(v)} ms`;
  if (v < 60_000) return `${num(v / 1000)} s`;
  return `${Math.floor(v / 60_000)}m ${Math.round((v % 60_000) / 1000)}s`;
};

const bytes = (b: number): string =>
  b < 1024 ? `${b} B` : b < 1024 ** 2 ? `${num(b / 1024, 1)} KB` : `${num(b / 1024 ** 2, 1)} MB`;

const pad2 = (n: number): string => String(n).padStart(2, '0');
const localTime = (iso: string | null): string => {
  if (!iso) return '–';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
};
const ago = (iso: string | null): string => {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
};
const elapsed = (r: RunItem): number | undefined =>
  r.startedAt ? new Date(r.updatedAt).getTime() - new Date(r.startedAt).getTime() : undefined;

/** Indented JSON with keys, strings, numbers and literals coloured. */
function highlight(value: unknown): string {
  const text = esc(JSON.stringify(value, null, 2));
  return text.replace(
    /(&quot;(?:\\.|(?!&quot;)[^\\])*&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g,
    (m, str: string | undefined, colon: string | undefined, lit: string | undefined) => {
      if (str) return colon ? `<span class="j-key">${str}</span>${colon}` : `<span class="j-str">${str}</span>`;
      if (lit) return `<span class="j-lit">${m}</span>`;
      return `<span class="j-num">${m}</span>`;
    },
  );
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message ?? `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/* ---------- state + URL hash ---------- */

let runs: RunItem[] = [];
let current: RunDetail | null = null;
let compareMetric: Metric = 'rate';
let view: 'db' | 'compare' = 'db';

function readHash(): { run: string | null; file: string | null } {
  const p = new URLSearchParams(location.hash.slice(1));
  return { run: p.get('run'), file: p.get('file') };
}
function writeHash(run: string, file?: string | null): void {
  const p = new URLSearchParams({ run });
  if (file) p.set('file', file);
  history.replaceState(null, '', `#${p}`);
}

/* ---------- run list ---------- */

function runMatches(r: RunItem, words: string[]): boolean {
  const hay = [r.id, localTime(r.startedAt), r.profile ?? '', ...r.dbs, ...r.tests, r.complete ? '' : 'incomplete'].join(' ').toLowerCase();
  return words.every((w) => hay.includes(w));
}

function renderList(): void {
  const words = $<HTMLInputElement>('run-filter').value.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = runs.filter((r) => runMatches(r, words));
  $('run-count').textContent = `(${shown.length}${shown.length === runs.length ? '' : `/${runs.length}`})`;
  const list = $('runs');
  if (!shown.length) {
    list.innerHTML = `<li class="empty">${runs.length ? 'no run matches' : 'results/ is empty: run a suite first'}</li>`;
    return;
  }
  list.innerHTML = shown
    .map((r) => {
      const tests = r.tests.length ? r.tests.join(' ') : 'all tests';
      const c = r.counts;
      return `<li data-id="${esc(r.id)}" class="${current?.id === r.id ? 'sel' : ''}" title="${esc(r.id)}">
        <div class="line"><span class="when">${esc(localTime(r.startedAt))}</span><span class="dimmer">${esc(ago(r.startedAt))}</span></div>
        <div class="line"><span class="acc">${esc(r.dbs.join(', ') || '–')}</span></div>
        <div class="line muted"><span>${esc(tests)}</span><span>@ ${esc(r.concurrency.join(',') || '–')}</span></div>
        <div class="line">
          <span class="ok">✓ ${c.ok}</span><span class="na">N/A ${c.na}</span><span class="${c.failed ? 'fail' : 'dimmer'}">✗ ${c.failed}</span>
          ${r.complete ? '' : '<span class="tag warn" title="No outcomes.json: stopped, crashed or still running. Numbers are rebuilt from the k6 files that landed.">incomplete</span>'}
        </div>
      </li>`;
    })
    .join('');
}

async function loadRuns(): Promise<void> {
  try {
    runs = await getJson<RunItem[]>('/api/runs');
  } catch (err) {
    $('runs').innerHTML = `<li class="empty fail">${esc((err as Error).message)}</li>`;
    return;
  }
  renderList();
  const { run, file } = readHash();
  const pick = run && runs.some((r) => r.id === run) ? run : runs[0]?.id;
  if (pick && pick !== current?.id) await openRun(pick, run === pick ? file : null);
}

/* ---------- one run ---------- */

async function openRun(id: string, file: string | null = null): Promise<void> {
  const detail = $('detail');
  detail.innerHTML = `<div class="card"><p class="empty">reading ${esc(id)}</p></div>`;
  try {
    current = await getJson<RunDetail>(`/api/runs/${encodeURIComponent(id)}`);
  } catch (err) {
    detail.innerHTML = `<div class="card"><p class="fail">${esc((err as Error).message)}</p></div>`;
    return;
  }
  writeHash(id, file);
  renderList();
  view = current.dbs.length > 1 && hasOverlap(current) ? 'compare' : 'db';
  detail.innerHTML = [overviewCard(current), resultsCard(), skippedCard(current), initCard(current), filesCard(current), viewerCard(), configCard(current)].join('');
  renderResults();
  wireFolds(detail);
  if (file) await openFile(file);
}

function overviewCard(r: RunDetail): string {
  const req = (r.run?.request ?? {}) as Record<string, unknown>;
  const cfg = (r.run?.config ?? {}) as Record<string, unknown> & { run?: { durationSec?: number; warmupSec?: number } };
  const list = (v: unknown): string => (Array.isArray(v) && v.length ? v.join(', ') : '–');
  const flag = (v: unknown, dflt: boolean): string => ((v ?? dflt) ? '<span class="ok">yes</span>' : '<span class="muted">no</span>');
  const overrides = req.overrides ? Object.keys(req.overrides as object) : [];
  const c = r.counts;
  const total = c.ok + c.na + c.failed;

  return `<div class="card">
    <div class="head">
      <h2>run <span class="acc">${esc(r.id)}</span></h2>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
        ${r.complete ? '<span class="tag good">complete</span>' : '<span class="tag warn" title="No outcomes.json: stopped, crashed or still running">incomplete</span>'}
        ${r.summary !== null ? `<a class="btn" href="/api/runs/${esc(r.id)}/summary" target="_blank">summary.md</a>` : ''}
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="k">ran ok</div><div class="v ok">${c.ok}</div></div>
      <div class="stat"><div class="k">N/A</div><div class="v na">${c.na}</div></div>
      <div class="stat"><div class="k">failed</div><div class="v ${c.failed ? 'fail' : ''}">${c.failed}</div></div>
      <div class="stat"><div class="k">wall time</div><div class="v">${esc(ms(elapsed(r)))}</div></div>
    </div>
    <dl class="kv">
      <dt>started</dt><dd>${esc(localTime(r.startedAt))} <span class="dimmer">${esc(ago(r.startedAt))}</span></dd>
      <dt>last write</dt><dd>${esc(localTime(r.updatedAt))}</dd>
      <dt>profile</dt><dd>${esc(r.profile ?? '–')}</dd>
      <dt>databases</dt><dd class="acc">${esc(list(r.dbs))}</dd>
      <dt>tests</dt><dd>${esc(r.tests.length ? r.tests.join(', ') : 'all')}</dd>
      <dt>concurrency</dt><dd>${esc(list(cfg.concurrency))} <span class="muted">VUs</span></dd>
      <dt>limits</dt><dd>${esc(list(cfg.limits))}</dd>
      <dt>shapes</dt><dd>${esc(list(cfg.shapes))}</dd>
      <dt>read modes</dt><dd>${esc(list(cfg.readModes))}</dd>
      <dt>timing</dt><dd>${esc(cfg.run?.durationSec ?? '–')} s measured, ${esc(cfg.run?.warmupSec ?? '–')} s warmup per k6 run</dd>
      <dt>initialize</dt><dd>${flag(req.initialize, true)} <span class="muted">fresh container + seed</span> · indexes ${flag(req.indexes, true)}</dd>
      <dt>overrides</dt><dd>${overrides.length ? esc(overrides.join(', ')) : '<span class="muted">none</span>'}</dd>
      <dt>outcomes</dt><dd>${total} <span class="muted">(one per cell per VU level; an N/A cell counts once)</span></dd>
      <dt>folder</dt><dd>results/${esc(r.id)}/ <span class="muted">· ${r.files} files, ${esc(bytes(r.bytes))}</span></dd>
    </dl>
  </div>`;
}

/* ---------- results table ---------- */

const runKey = (o: Outcome): string => `${o.cell}@${o.vus}`;

/** Some cell@vus ran on more than one database, so there is something to compare. */
function hasOverlap(r: RunDetail): boolean {
  const seen = new Map<string, Set<string>>();
  for (const o of r.outcomes) {
    if (o.status !== 'ok') continue;
    const s = seen.get(runKey(o)) ?? new Set();
    s.add(o.db);
    seen.set(runKey(o), s);
    if (s.size > 1) return true;
  }
  return false;
}

function resultsCard(): string {
  return `<div class="card flush" id="results-card">
    <div class="head">
      <h2 class="fold">results</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap">
        <span id="view-switch" style="display:flex;gap:4px"></span>
        <select id="metric" class="filter hidden" style="width:auto;padding:3px 6px"></select>
        <input id="res-filter" class="filter" style="width:200px;padding:3px 8px" placeholder="filter, e.g. r1 cursor" />
      </div>
    </div>
    <div class="scroll" style="max-height:620px;overflow:auto"><table id="res-table"></table></div>
    <div class="legend" id="res-legend"></div>
  </div>`;
}

function renderResults(): void {
  if (!current) return;
  const r = current;
  const ok = r.outcomes.filter((o) => o.status === 'ok' && o.compact);
  const words = ($<HTMLInputElement>('res-filter')?.value ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  const match = (o: Outcome): boolean => words.every((w) => `${o.db} ${o.cell} @${o.vus}`.toLowerCase().includes(w));
  const multi = r.dbs.length > 1 && hasOverlap(r);

  const sw = $('view-switch');
  sw.innerHTML = multi
    ? (['db', 'compare'] as const)
        .map((v) => `<button class="btn" data-view="${v}" style="${v === view ? 'background:var(--accent);color:#000;border-color:var(--accent)' : ''}">${v === 'db' ? 'by db' : 'compare dbs'}</button>`)
        .join('')
    : '';
  const metricSel = $<HTMLSelectElement>('metric');
  metricSel.classList.toggle('hidden', view !== 'compare');
  if (!metricSel.options.length) {
    metricSel.innerHTML = TABLE_METRICS.map((m) => `<option value="${m}">${METRICS[m].label}</option>`).join('');
  }
  metricSel.value = compareMetric;

  const table = $('res-table');
  const legend = $('res-legend');
  if (!ok.length) {
    table.innerHTML = `<tbody><tr><td class="muted" style="padding:16px">no cell finished in this run</td></tr></tbody>`;
    legend.textContent = '';
    return;
  }

  // Best (and, with 3+ databases, worst) per cell@vus across databases, per metric.
  const groups = new Map<string, Outcome[]>();
  for (const o of ok) groups.set(runKey(o), [...(groups.get(runKey(o)) ?? []), o]);
  const rank = (o: Outcome, m: Metric): string => {
    const g = groups.get(runKey(o))!;
    if (g.length < 2) return '';
    const vals = g.map((x) => METRICS[m].get(x.compact!)).filter((v): v is number => v !== undefined);
    const v = METRICS[m].get(o.compact!);
    if (v === undefined || vals.length < 2) return '';
    const best = METRICS[m].higher ? Math.max(...vals) : Math.min(...vals);
    const worst = METRICS[m].higher ? Math.min(...vals) : Math.max(...vals);
    if (v === best) return 'best';
    return g.length >= 3 && v === worst ? 'worst' : '';
  };

  if (view === 'compare' && multi) {
    const dbs = r.dbs.filter((d) => ok.some((o) => o.db === d));
    const keys = [...groups.keys()].filter((k) => groups.get(k)!.some(match));
    const m = METRICS[compareMetric];
    table.innerHTML = `<thead><tr><th>cell</th><th class="num">VUs</th>${dbs.map((d) => `<th class="num">${esc(d)}</th>`).join('')}</tr></thead>
      <tbody>${keys
        .map((k) => {
          const g = groups.get(k)!;
          const first = g[0]!;
          return `<tr><td>${esc(first.cell)}</td><td class="num">${first.vus}</td>${dbs
            .map((d) => {
              const o = g.find((x) => x.db === d);
              if (!o) return `<td class="num dimmer">–</td>`;
              return `<td class="num click ${rank(o, compareMetric)}" data-file="${esc(cellFile(o))}" style="cursor:pointer">${num(m.get(o.compact!))}</td>`;
            })
            .join('')}</tr>`;
        })
        .join('')}</tbody>`;
    legend.innerHTML = `${esc(m.label)}${m.higher ? ' (higher is better)' : ' in ms (lower is better)'} · <span class="ok">★ best</span> per row` +
      `${dbs.length >= 3 ? ' · <span class="fail">worst</span>' : ''} · – not run there (N/A, failed or not selected) · click a value to open its k6 file`;
    return;
  }

  const rows: string[] = [];
  for (const db of r.dbs) {
    const mine = ok.filter((o) => o.db === db && match(o));
    if (!mine.length) continue;
    rows.push(`<tr class="group"><td colspan="${TABLE_METRICS.length + 5}">${esc(db)} <span class="dimmer" style="font-weight:400">${mine.length} runs</span></td></tr>`);
    for (const o of mine) {
      const c = o.compact!;
      const errs = c.errors?.count ?? 0;
      const uk = c.uk_violations?.count ?? 0;
      rows.push(`<tr class="click" data-file="${esc(cellFile(o))}">
        <td>${esc(o.cell)}</td><td class="num">${o.vus}</td>
        ${TABLE_METRICS.map((m) => `<td class="num ${multi ? rank(o, m) : ''}">${num(METRICS[m].get(c))}</td>`).join('')}
        <td class="num">${num(c.rows?.avg, 1)}</td>
        <td class="num ${errs ? 'fail' : 'dimmer'}" title="${errs ? `${num(c.errors?.rate)} errors/s` : ''}">${errs ? num(errs, 0) : 0}</td>
        <td class="num ${uk ? 'na' : 'dimmer'}">${uk ? num(uk, 0) : 0}</td>
      </tr>`);
    }
  }
  table.innerHTML = `<thead><tr><th>cell</th><th class="num">VUs</th>${TABLE_METRICS.map((m) => `<th class="num">${METRICS[m].label}</th>`).join('')}
    <th class="num">rows/op</th><th class="num">errors</th><th class="num">uk</th></tr></thead>
    <tbody>${rows.join('') || `<tr><td colspan="${TABLE_METRICS.length + 5}" class="muted">no row matches</td></tr>`}</tbody>`;
  legend.innerHTML = 'latency in ms · <b>http</b> = end to end as k6 saw it · <b>db</b> = server-side time of the database call alone · ' +
    '<b>uk</b> = unique-key hits (expected in W2)' + (multi ? ' · <span class="ok">★ best</span> across databases for the same cell@VUs' : '') +
    ' · click a row to open its k6 file';
}

/** Mirrors runCell's file name in suite/run.ts. */
const cellFile = (o: Outcome): string => `${o.db}/${o.cell.replace(/[^\w+-]+/g, '_')}@${o.vus}.json`;

/* ---------- skipped / failed ---------- */

function skippedCard(r: RunDetail): string {
  const notRun = r.outcomes.filter((o) => o.status !== 'ok');
  if (!notRun.length) return '';
  const failed = notRun.filter((o) => o.status === 'failed').length;
  const byDb = r.dbs.map((db) => [db, notRun.filter((o) => o.db === db)] as const).filter(([, l]) => l.length);
  return `<div class="card ${failed ? '' : 'collapsed'}">
    <div class="head"><h2 class="fold">not run <span class="muted">${notRun.length - failed} N/A${failed ? `, <span class="fail">${failed} failed</span>` : ''}</span></h2></div>
    <div>${byDb
      .map(
        ([db, list]) => `<h3>${esc(db)}</h3><ul class="reasons">${list
          .map(
            (o) => `<li><span class="${o.status === 'na' ? 'na' : 'fail'}">${o.status === 'na' ? 'N/A' : 'FAIL'}</span>
            <span>${esc(o.cell)}${o.vus ? ` <span class="muted">@ ${o.vus}</span>` : ''} <span class="muted">— ${esc(o.reason ?? '')}</span></span></li>`,
          )
          .join('')}</ul>`,
      )
      .join('')}</div>
  </div>`;
}

/* ---------- initialize ---------- */

function bars(entries: [string, number][], total?: number): string {
  const max = Math.max(...entries.map(([, v]) => v), 1);
  const rowsHtml = entries
    .map(([k, v]) => {
      const n = Math.max(v > 0 ? 1 : 0, Math.round((v / max) * BAR_WIDTH));
      return `<span class="muted">${esc(k)}</span><span class="bar">${'█'.repeat(n)}<span class="rest">${'░'.repeat(BAR_WIDTH - n)}</span></span><span class="num">${esc(ms(v))}</span>`;
    })
    .join('');
  const totalHtml = total === undefined ? '' : `<span class="total">total</span><span></span><span class="num total">${esc(ms(total))}</span>`;
  return `<div class="bars">${rowsHtml}${totalHtml}</div>`;
}

function initCard(r: RunDetail): string {
  const dbs = Object.keys(r.initialize);
  if (!dbs.length) {
    return `<div class="card collapsed"><div class="head"><h2 class="fold">initialize <span class="muted">not run: databases were used as they were</span></h2></div></div>`;
  }
  const body = dbs
    .map((db) => {
      const i = r.initialize[db]!;
      const { total, ...load } = i.loadMs ?? {};
      const container: [string, number][] = [];
      if (i.container?.downMs !== undefined) container.push(['container down', i.container.downMs]);
      if (i.container?.upMs !== undefined) container.push(['container up', i.container.upMs]);
      const idx = Object.entries(i.indexMs ?? {});
      return `<h3>${esc(db)} <a class="small" href="#" data-file="${esc(db)}/initialize.json">initialize.json</a></h3>
        ${container.length ? bars(container) : ''}
        ${Object.keys(load).length ? `<div class="small dimmer" style="margin-top:6px">seed load</div>${bars(Object.entries(load), total)}` : ''}
        ${idx.length ? `<div class="small dimmer" style="margin-top:6px">search indexes</div>${bars(idx, idx.reduce((a, [, v]) => a + v, 0))}` : '<div class="small dimmer" style="margin-top:6px">search indexes: none built</div>'}`;
    })
    .join('');
  return `<div class="card collapsed"><div class="head"><h2 class="fold">initialize <span class="muted">${dbs.length} database${dbs.length > 1 ? 's' : ''}</span></h2></div><div>${body}</div></div>`;
}

/* ---------- files ---------- */

function filesCard(r: RunDetail): string {
  // Run folders are at most two levels deep: top-level files, then one folder per database.
  const top = r.tree.filter((f) => !f.path.includes('/'));
  const dirs = new Map<string, { name: string; path: string; bytes: number }[]>();
  for (const f of r.tree) {
    const i = f.path.indexOf('/');
    if (i < 0) continue;
    const d = f.path.slice(0, i);
    dirs.set(d, [...(dirs.get(d) ?? []), { name: f.path.slice(i + 1), path: f.path, bytes: f.bytes }]);
  }
  const entries: string[] = [];
  const dirList = [...dirs.entries()];
  const items = [...dirList.map(([d]) => ({ dir: d })), ...top.map((f) => ({ file: f }))];
  items.forEach((it, i) => {
    const last = i === items.length - 1;
    const branch = `<span class="g">${last ? '└── ' : '├── '}</span>`;
    if ('dir' in it) {
      const files = dirs.get(it.dir!)!;
      entries.push(`${branch}<span class="d">${esc(it.dir)}/</span> <span class="g">${files.length} files</span>`);
      files.forEach((f, j) => {
        const twig = `<span class="g">${last ? '    ' : '│   '}${j === files.length - 1 ? '└── ' : '├── '}</span>`;
        entries.push(`${twig}<span class="f" data-file="${esc(f.path)}">${esc(f.name)}</span> <span class="g">${esc(bytes(f.bytes))}</span>`);
      });
    } else {
      entries.push(`${branch}<span class="f" data-file="${esc(it.file!.path)}">${esc(it.file!.path)}</span> <span class="g">${esc(bytes(it.file!.bytes))}</span>`);
    }
  });
  return `<div class="card collapsed">
    <div class="head"><h2 class="fold">files <span class="muted">${r.files}, ${esc(bytes(r.bytes))}</span></h2></div>
    <pre class="tree"><span class="d">results/${esc(r.id)}/</span>\n${entries.join('\n')}</pre>
  </div>`;
}

/* ---------- file viewer ---------- */

function viewerCard(): string {
  return `<div class="card hidden" id="viewer">
    <div class="head"><h2 id="viewer-title">file</h2>
      <div style="display:flex;gap:6px"><a id="viewer-raw" class="btn" target="_blank">raw</a><button id="viewer-close" class="btn">close</button></div>
    </div>
    <div id="viewer-body"></div>
  </div>`;
}

function statsTable(rows: [string, Stats | null | undefined, string][]): string {
  const cols: (keyof Stats)[] = ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max', 'count'];
  return `<div class="scroll"><table><thead><tr><th></th>${cols.map((c) => `<th class="num">${c === 'med' ? 'p50' : esc(c)}</th>`).join('')}</tr></thead><tbody>${rows
    .map(
      ([label, s, unit]) =>
        `<tr><td>${esc(label)} <span class="dimmer">${esc(unit)}</span></td>${cols
          .map((c) => `<td class="num">${s ? num(s[c], c === 'count' ? 0 : 2) : '–'}</td>`)
          .join('')}</tr>`,
    )
    .join('')}</tbody></table></div>`;
}

interface K6Metric {
  type: string;
  contains?: string;
  values: Record<string, number>;
}

function k6View(data: { compact?: Compact; full?: { metrics?: Record<string, K6Metric>; state?: { testRunDurationMs?: number } } }): string {
  const parts: string[] = [];
  const c = data.compact;
  if (c) {
    parts.push(`<h3>measured window</h3>
      <dl class="kv" style="margin-bottom:10px">
        <dt>throughput</dt><dd><b>${num(c.reqs?.rate)}</b> req/s <span class="muted">(${num(c.reqs?.count, 0)} requests)</span></dd>
        <dt>errors</dt><dd class="${c.errors?.count ? 'fail' : ''}">${num(c.errors?.count ?? 0, 0)}${c.errors?.count ? ` <span class="muted">(${num(c.errors.rate)}/s)</span>` : ''}</dd>
        <dt>unique-key hits</dt><dd>${num(c.uk_violations?.count ?? 0, 0)}</dd>
        <dt>VUs</dt><dd>${c.vus}</dd>
        ${data.full?.state?.testRunDurationMs ? `<dt>k6 wall time</dt><dd>${esc(ms(data.full.state.testRunDurationMs))} <span class="muted">incl. warmup</span></dd>` : ''}
      </dl>
      ${statsTable([['http', c.http_req_duration, 'ms'], ['db', c.db_ms, 'ms'], ['rows', c.rows, 'per op']])}`);
  }
  const metrics = data.full?.metrics;
  if (metrics) {
    const names = Object.keys(metrics).sort();
    parts.push(`<h3>all k6 metrics <span class="dimmer small" style="font-weight:400">whole run, warmup included</span></h3>
      <div class="scroll"><table><thead><tr><th>metric</th><th>type</th><th class="num">avg / rate</th><th class="num">p50</th><th class="num">p95</th><th class="num">p99</th><th class="num">max</th><th class="num">count</th></tr></thead><tbody>${names
        .map((n) => {
          const m = metrics[n]!;
          const v = m.values;
          const main = m.type === 'rate' ? `${num((v.rate ?? 0) * 100)}%` : m.type === 'counter' ? `${num(v.rate)}/s` : num(v.avg ?? v.value);
          return `<tr><td>${esc(n)}</td><td class="muted">${esc(m.type)}</td><td class="num">${main}</td><td class="num">${num(v.med)}</td>
            <td class="num">${num(v['p(95)'])}</td><td class="num">${num(v['p(99)'])}</td><td class="num">${num(v.max)}</td>
            <td class="num">${num(v.count ?? v.passes, 0)}</td></tr>`;
        })
        .join('')}</tbody></table></div>`);
  }
  return parts.join('');
}

function initView(data: InitResult): string {
  const { container, ...rest } = data;
  const out = container?.output ? `<h3>docker output</h3><pre class="out">${esc(container.output)}</pre>` : '';
  return `${out}<h3>result</h3><pre class="out">${highlight({ ...rest, container: container ? { downMs: container.downMs, upMs: container.upMs } : undefined })}</pre>`;
}

async function openFile(path: string): Promise<void> {
  if (!current) return;
  const viewer = $('viewer');
  const url = `/api/runs/${encodeURIComponent(current.id)}/file?path=${encodeURIComponent(path)}`;
  viewer.classList.remove('hidden', 'collapsed');
  $('viewer-title').innerHTML = `<span class="acc">${esc(path)}</span>`;
  $<HTMLAnchorElement>('viewer-raw').href = url;
  const body = $('viewer-body');
  body.innerHTML = '<p class="empty">reading</p>';
  document.querySelectorAll('.tree .f').forEach((el) => el.classList.toggle('sel', (el as HTMLElement).dataset.file === path));
  writeHash(current.id, path);
  viewer.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const res = await fetch(url);
  if (!res.ok) {
    body.innerHTML = `<p class="fail">${esc(res.status)} ${esc(await res.text())}</p>`;
    return;
  }
  if (!path.endsWith('.json')) {
    body.innerHTML = `<pre class="out">${esc(await res.text())}</pre>`;
    return;
  }
  const data = (await res.json()) as Record<string, unknown>;
  const name = path.split('/').pop()!;
  let head = '';
  if (name === 'initialize.json') head = initView(data as InitResult);
  else if (/@\d+\.json$/.test(name)) head = k6View(data as Parameters<typeof k6View>[0]);
  const raw = `<pre class="out">${highlight(data)}</pre>`;
  body.innerHTML = head ? `${head}<details style="margin-top:12px"><summary class="muted" style="cursor:pointer">raw json</summary>${raw}</details>` : raw;
}

/* ---------- config ---------- */

function configCard(r: RunDetail): string {
  if (!r.run) return '';
  return `<div class="card collapsed">
    <div class="head"><h2 class="fold">run.json <span class="muted">request + resolved config</span></h2></div>
    <h3>request</h3><pre class="out">${highlight(r.run.request ?? null)}</pre>
    <h3>config</h3><pre class="out">${highlight(r.run.config ?? null)}</pre>
  </div>`;
}

/* ---------- wiring ---------- */

function wireFolds(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('h2.fold').forEach((h) => {
    h.tabIndex = 0;
    const toggle = (): void => {
      h.closest('.card')!.classList.toggle('collapsed');
    };
    h.addEventListener('click', toggle);
    h.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggle();
      }
    });
  });
}

$('runs').addEventListener('click', (e) => {
  const li = (e.target as HTMLElement).closest<HTMLElement>('li[data-id]');
  if (li && li.dataset.id !== current?.id) void openRun(li.dataset.id!);
});
$('run-filter').addEventListener('input', renderList);
$('refresh').addEventListener('click', async () => {
  const keep = current?.id;
  current = null;
  await loadRuns();
  if (keep && runs.some((r) => r.id === keep) && current === null) await openRun(keep);
});

$('detail').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const fileEl = t.closest<HTMLElement>('[data-file]');
  if (fileEl) {
    e.preventDefault();
    void openFile(fileEl.dataset.file!);
    return;
  }
  const v = t.closest<HTMLElement>('[data-view]');
  if (v) {
    view = v.dataset.view as typeof view;
    renderResults();
    return;
  }
  if (t.id === 'viewer-close') {
    $('viewer').classList.add('hidden');
    document.querySelectorAll('.tree .f.sel').forEach((el) => el.classList.remove('sel'));
    if (current) writeHash(current.id);
  }
});
$('detail').addEventListener('input', (e) => {
  if ((e.target as HTMLElement).id === 'res-filter') renderResults();
});
$('detail').addEventListener('change', (e) => {
  const t = e.target as HTMLSelectElement;
  if (t.id === 'metric') {
    compareMetric = t.value as Metric;
    renderResults();
  }
});
window.addEventListener('hashchange', () => {
  const { run, file } = readHash();
  if (run && run !== current?.id) void openRun(run, file);
  else if (file && current) void openFile(file);
});

void loadRuns();
