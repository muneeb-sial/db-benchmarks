/**
 * Runner UI. Each test declares its fields; those become the query string for
 * a single request and, upper-cased, the -e env for a k6 run. Coverage from
 * GET /:db/coverage marks N/A combinations before anything is sent.
 */

import { applyStaticTips, DB_HELP, fieldHelp, INDEX_HELP, optionHelp, TABLE_HELP, TIMING_HELP, tip } from './help.ts';
import { initSuite, type ApiConfig } from './suite.ts';

type Values = Record<string, string>;

interface Field {
  name: string;
  label: string;
  kind: 'select' | 'number' | 'text';
  options?: string[] | (() => string[]);
  value: string;
  /** Field applies only when this returns true. */
  when?: (v: Values) => boolean;
  /** Not sent to the server for a single request (k6-only). */
  k6Only?: boolean;
  /** Hover help for the field. */
  help?: string;
}

interface Test {
  id: string;
  label: string;
  method: 'GET' | 'POST';
  path: (db: string) => string;
  help: string;
  fields: Field[];
  /** Key into /:db/coverage for the current values. */
  coverage: (v: Values) => string[];
}

const SHAPES = ['simple', 'single-join', 'multi-join'];
const MODES = ['limit', 'offset', 'cursor'];

let limits = ['100', '1000'];
const plantedLimits = (): string[] => limits;

const shape: Field = { name: 'shape', label: 'Shape', kind: 'select', options: SHAPES, value: 'simple' };
const mode: Field = { name: 'mode', label: 'Mode', kind: 'select', options: MODES, value: 'limit' };
const limit: Field = { name: 'limit', label: 'Limit', kind: 'number', value: '100' };
const offset: Field = { name: 'offset', label: 'Offset', kind: 'number', value: '0', when: (v) => v.mode === 'offset' };
const after: Field = { name: 'after', label: 'After (cursor)', kind: 'number', value: '0', when: (v) => v.mode === 'cursor' };
const paged = [shape, mode, limit, offset, after];
const pagedKey = (t: string) => (v: Values) => [`${t} ${v.shape} ${v.mode}`];

const TESTS: Test[] = [
  { id: 'r1', label: 'R1 · scan, no filter', method: 'GET', path: (d) => `/${d}/read/r1`,
    help: 'No filter, paged by limit / offset / cursor.', fields: paged, coverage: pagedKey('r1') },
  { id: 'r2', label: 'R2 · unique key (email)', method: 'GET', path: (d) => `/${d}/read/r2`,
    help: 'Lookup on the unique email column. k6 picks a fresh random user per request.',
    fields: [...paged, { name: 'email', label: 'Email', kind: 'text', value: 'user42@bench.test' }], coverage: pagedKey('r2') },
  { id: 'r3', label: 'R3 · unindexed filter (score)', method: 'GET', path: (d) => `/${d}/read/r3`,
    help: 'score < cutoff on a column with no index (~50% of rows).', fields: paged, coverage: pagedKey('r3') },
  { id: 'r4', label: 'R4 · whole-table walk', method: 'GET', path: (d) => `/${d}/read/r4`,
    help: 'One page per request; the k6 run walks the whole table page by page.',
    fields: [shape, { ...mode, value: 'cursor' }, { ...limit, value: '1000' }, offset, after,
      { name: 'max_pages', label: 'Max pages (k6)', kind: 'number', value: '50', k6Only: true }],
    coverage: pagedKey('r4') },
  { id: 'r5', label: 'R5 · primary-key lookup', method: 'GET', path: (d) => `/${d}/read/r5`,
    help: 'Point lookup by id, or multi-get IN (...).',
    fields: [
      { name: 'kind', label: 'Kind', kind: 'select', options: ['id', 'multi'], value: 'id' },
      { ...shape, when: (v) => v.kind === 'id' },
      { name: 'id', label: 'Id', kind: 'number', value: '42', when: (v) => v.kind === 'id' },
      { name: 'hot', label: 'Hot keys (k6)', kind: 'select', options: ['0', '1'], value: '0', when: (v) => v.kind === 'id', k6Only: true },
      { name: 'size', label: 'Keys', kind: 'select', options: ['100', '1000'], value: '100', when: (v) => v.kind === 'multi' },
      { name: 'slot', label: 'Slot', kind: 'number', value: '1', when: (v) => v.kind === 'multi' },
    ],
    coverage: (v) => [v.kind === 'multi' ? 'r5 multi' : `r5 id ${v.shape}`] },
  { id: 'r6', label: 'R6 · created_at range', method: 'GET', path: (d) => `/${d}/read/r6`,
    help: 'BETWEEN on the indexed created_at, sized to match `limit` users.', fields: paged, coverage: pagedKey('r6') },
  { id: 'r7', label: 'R7 · aggregates', method: 'GET', path: (d) => `/${d}/read/r7`, help: 'COUNT / SUM / GROUP BY.',
    fields: [{ name: 'variant', label: 'Variant', kind: 'select', value: 'count-all',
      options: ['count-all', 'count-indexed', 'count-unindexed', 'sum-views', 'posts-per-user', 'likes-per-post', 'likes-per-user'] }],
    coverage: (v) => [`r7 ${v.variant}`] },
  { id: 'r8', label: 'R8 · sort / top-N', method: 'GET', path: (d) => `/${d}/read/r8`,
    help: 'Top-N on an indexed (created_at) vs unindexed (score) key, or a capped full sort.',
    fields: [
      { name: 'kind', label: 'Kind', kind: 'select', options: ['topn', 'fullsort'], value: 'topn' },
      { ...shape, when: (v) => v.kind === 'topn' },
      { name: 'key', label: 'Sort key', kind: 'select', options: ['indexed', 'unindexed'], value: 'indexed', when: (v) => v.kind === 'topn' },
      { ...limit, when: (v) => v.kind === 'topn' },
    ],
    coverage: (v) => [v.kind === 'fullsort' ? 'r8 fullsort' : `r8 topn ${v.shape} ${v.key}`] },
  { id: 'r9', label: 'R9 · text search', method: 'GET', path: (d) => `/${d}/read/r9`,
    help: 'LIKE / regex on planted markers, or full-text. Limit must be a planted limit.',
    fields: [
      { name: 'kind', label: 'Kind', kind: 'select', options: ['like', 'fulltext'], value: 'like' },
      { name: 'pattern', label: 'Pattern', kind: 'select', options: ['prefix', 'contains', 'suffix'], value: 'prefix', when: (v) => v.kind === 'like' },
      { name: 'limit', label: 'Limit', kind: 'select', options: plantedLimits, value: '100' },
      { name: 'index', label: 'Index (k6)', kind: 'select', options: ['', 'name-prefix', 'fulltext'], value: '', k6Only: true },
    ],
    coverage: (v) => [v.kind === 'fulltext' ? 'r9 fulltext' : `r9 like ${v.pattern}`] },
  { id: 'r10', label: 'R10 · JSON filter', method: 'GET', path: (d) => `/${d}/read/r10`,
    help: 'Filter documents on a top-level field, a nested field, or array membership.',
    fields: [
      { name: 'variant', label: 'Variant', kind: 'select', options: ['top-level', 'nested', 'array-contains'], value: 'top-level' },
      { name: 'limit', label: 'Limit', kind: 'select', options: plantedLimits, value: '100' },
      { name: 'index', label: 'Index (k6)', kind: 'select', options: ['', 'json-top', 'json-nested', 'json-array'], value: '', k6Only: true },
    ],
    coverage: (v) => [`r10 ${v.variant}`] },
  { id: 'w1', label: 'W1 · single insert', method: 'POST', path: (d) => `/${d}/write/w1`, help: 'Insert one row into w_plain.',
    fields: [{ name: 'id', label: 'Id', kind: 'number', value: '1' },
      { name: 'rows', label: 'Rows (k6)', kind: 'number', value: '1000', k6Only: true }],
    coverage: () => ['w1'] },
  { id: 'w2', label: 'W2 · insert with unique key', method: 'POST', path: (d) => `/${d}/write/w2`,
    help: 'Insert into w_uk. Set "dup" to an existing id to force a unique-key violation (409).',
    fields: [{ name: 'id', label: 'Id', kind: 'number', value: '1' },
      { name: 'dup', label: 'Dup of id', kind: 'text', value: '' },
      { name: 'rows', label: 'Rows (k6)', kind: 'number', value: '1000', k6Only: true }],
    coverage: () => ['w2'] },
  { id: 'w3', label: 'W3 · batch insert', method: 'POST', path: (d) => `/${d}/write/w3`, help: 'One batch of `size` rows into w_plain.',
    fields: [{ name: 'start', label: 'Start id', kind: 'number', value: '1' },
      { name: 'size', label: 'Batch size', kind: 'number', value: '1000' },
      { name: 'max_rows', label: 'Max rows (k6)', kind: 'number', value: '20000', k6Only: true }],
    coverage: () => ['w3'] },
  { id: 'w4', label: 'W4 · JSON document insert', method: 'POST', path: (d) => `/${d}/write/w4`, help: 'Insert one document into w_docs.',
    fields: [{ name: 'id', label: 'Id', kind: 'number', value: '1' },
      { name: 'rows', label: 'Rows (k6)', kind: 'number', value: '1000', k6Only: true }],
    coverage: () => ['w4'] },
  { id: 'like', label: 'Like transaction', method: 'POST', path: (d) => `/${d}/like`,
    help: 'like_count += 1 and insert into likes, atomically. The k6 run checks integrity at the end.',
    fields: [{ name: 'post', label: 'Post id', kind: 'number', value: '1' },
      { name: 'user', label: 'User id', kind: 'number', value: '1' },
      { name: 'contention', label: 'Contention (k6)', kind: 'select', options: ['uniform', 'hot'], value: 'uniform', k6Only: true }],
    coverage: () => ['like'] },
];

const K6_FIELDS: Field[] = [
  { name: 'vus', label: 'VUs (concurrency)', kind: 'number', value: '8', help: TIMING_HELP.vus },
  { name: 'duration', label: 'Duration (s)', kind: 'number', value: '5', help: TIMING_HELP.duration },
  { name: 'warmup', label: 'Warmup (s)', kind: 'number', value: '1', help: TIMING_HELP.warmup },
];

// ------------------------------------------------------------------- DOM --

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const dbSel = $<HTMLSelectElement>('db');
const testSel = $<HTMLSelectElement>('test');
const fieldsEl = $('fields');
const k6FieldsEl = $('k6-fields');
const output = $('output');
const coverageEl = $('coverage');

const INPUT = 'w-full rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-sm text-slate-100 placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/30';

let coverage: Record<string, string> = {};
const values: Record<string, Values> = {};
const k6Values: Values = Object.fromEntries(K6_FIELDS.map((f) => [f.name, f.value]));
let k6Abort: AbortController | null = null;

const currentTest = (): Test => TESTS.find((t) => t.id === testSel.value)!;

function testValues(t: Test): Values {
  values[t.id] ??= Object.fromEntries(t.fields.map((f) => [f.name, f.value]));
  return values[t.id]!;
}

/** `test` scopes the help lookup: `kind`, `size` or `variant` mean different things per test. */
function renderFields(container: HTMLElement, fields: Field[], v: Values, onChange: () => void, test = ''): void {
  container.replaceChildren();
  for (const f of fields) {
    if (f.when && !f.when(v)) continue;
    const label = document.createElement('label');
    label.className = 'block text-xs font-medium text-slate-400';
    label.textContent = f.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.kind === 'select') {
      input = document.createElement('select');
      const opts = typeof f.options === 'function' ? f.options() : f.options ?? [];
      const perOption = optionHelp(test, f.name);
      for (const o of opts) {
        const option = new Option(o === '' ? '(none)' : o, o);
        if (perOption?.[o]) option.title = perOption[o]!;
        input.append(option);
      }
      if (!opts.includes(v[f.name] ?? '')) v[f.name] = opts[0] ?? '';
    } else {
      input = document.createElement('input');
      input.type = f.kind === 'number' ? 'number' : 'text';
      if (f.kind === 'number') input.min = '0';
    }
    input.className = `${INPUT} mt-1`;
    input.value = v[f.name] ?? '';
    // The field's own help, plus what the selected option means; k6-only fields say so.
    const help = f.help ?? fieldHelp(test, f.name, v[f.name]);
    tip(label, f.k6Only && !help.startsWith('k6 only') ? `k6 only: sent to the load run, not to "Execute once".\n\n${help}` : help);
    input.addEventListener('input', () => {
      v[f.name] = input.value;
      // Changing a select can show or hide other fields (and changes its tooltip).
      if (input instanceof HTMLSelectElement) renderFields(container, fields, v, onChange, test);
      onChange();
    });
    label.append(input);
    container.append(label);
  }
}

function activeParams(t: Test, v: Values, k6: boolean): Values {
  const out: Values = {};
  for (const f of t.fields) {
    if (f.when && !f.when(v)) continue;
    if (f.k6Only && !k6) continue;
    const val = v[f.name] ?? '';
    if (val !== '') out[f.name] = val;
  }
  return out;
}

function requestUrl(): string {
  const t = currentTest();
  const qs = new URLSearchParams(activeParams(t, testValues(t), false)).toString();
  return `${t.path(dbSel.value)}${qs ? `?${qs}` : ''}`;
}

function refresh(): void {
  const t = currentTest();
  $('test-help').textContent = t.help;
  $('preview').textContent = `${t.method} ${requestUrl()}`;
  const reasons = t.coverage(testValues(t)).map((k) => coverage[k]).filter((r) => r && r !== 'ok');
  coverageEl.classList.toggle('hidden', reasons.length === 0);
  coverageEl.textContent = reasons.length ? `N/A on ${dbSel.value}: ${reasons.join('; ')}` : '';
}

function renderTest(): void {
  const t = currentTest();
  renderFields(fieldsEl, t.fields, testValues(t), refresh, t.id);
  tip(testSel, `${t.label}\n${t.help}`);
  refresh();
}

function show(title: string, text: string): void {
  $('out-title').textContent = title;
  output.textContent = text;
}

function metric(id: string, v: string): void {
  $(id).textContent = v;
}

function addHistory(req: string, status: number, rows: unknown, dbMs: unknown, rtt: number): void {
  const tr = document.createElement('tr');
  const ok = status >= 200 && status < 300;
  const cells = [new Date().toLocaleTimeString(), req, String(status), rows ?? '', dbMs ?? '', rtt.toFixed(1)];
  cells.forEach((c, i) => {
    const td = document.createElement('td');
    td.className = `px-4 py-1.5 ${i >= 2 ? 'text-right tabular-nums' : ''} ${i === 1 ? 'font-mono break-all' : ''}`;
    if (i === 2) td.className += ok ? ' text-emerald-400' : ' text-rose-400';
    td.textContent = String(c);
    tr.append(td);
  });
  const body = $('history');
  body.prepend(tr);
  while (body.children.length > 25) body.lastElementChild?.remove();
}

async function call(method: string, url: string): Promise<void> {
  const t0 = performance.now();
  let status = 0;
  let body: Record<string, unknown> = {};
  try {
    const res = await fetch(url, { method });
    status = res.status;
    body = await res.json().catch(() => ({}));
  } catch (err) {
    body = { error: String(err) };
  }
  const rtt = performance.now() - t0;
  metric('m-status', String(status || 'ERR'));
  metric('m-rows', body.rows === undefined ? '–' : String(body.rows));
  metric('m-db', body.dbMs === undefined ? '–' : `${body.dbMs} ms`);
  metric('m-rtt', `${rtt.toFixed(1)} ms`);
  show(`${method} ${url}`, JSON.stringify(body, null, 2));
  addHistory(`${method} ${url}`, status, body.rows, body.dbMs, rtt);
}

async function loadStatus(): Promise<void> {
  const db = dbSel.value;
  const [status, cov] = await Promise.all([
    fetch(`/${db}/status`).then((r) => r.json()),
    fetch(`/${db}/coverage`).then((r) => r.json()).catch(() => ({})),
  ]);
  coverage = cov;
  const badge = $('db-status');
  const ok = Boolean(status.initialized);
  badge.textContent = status.initializing ? 'initializing…' : ok ? 'initialized' : 'not initialized';
  badge.className = `rounded-full px-2.5 py-1 text-xs font-medium ${ok ? 'bg-emerald-500/15 text-emerald-300' : 'bg-amber-500/15 text-amber-300'}`;
  const detail = $('db-detail');
  detail.replaceChildren();
  if (ok) {
    detail.append(`${status.manifest.users.toLocaleString()} users · ${status.manifest.posts.toLocaleString()} posts · loaded in ${status.loadMs.total} ms`);
    const row = document.createElement('div');
    row.className = 'mt-1.5 flex flex-wrap items-center gap-1';
    row.append('search indexes:');
    const present: string[] = status.indexes ?? [];
    for (const kind of present) {
      const b = document.createElement('span');
      b.className = 'rounded bg-indigo-500/15 px-1.5 py-0.5 text-[11px] text-indigo-300';
      b.textContent = kind;
      tip(b, INDEX_HELP[kind] ?? kind);
      row.append(b);
    }
    if (!present.length) row.append(' none');
    detail.append(row);
  } else {
    detail.textContent = 'Reinitialize to load the seed into this database.';
  }
  if (ok) limits = status.manifest.limits.map(String);
  renderTest();
}

async function runK6(): Promise<void> {
  const t = currentTest();
  const env: Values = { script: t.id, DB: dbSel.value, VUS: k6Values.vus!, DURATION: k6Values.duration!, WARMUP: k6Values.warmup! };
  for (const [k, v] of Object.entries(activeParams(t, testValues(t), true))) {
    if (['email', 'id', 'offset', 'after', 'slot', 'start', 'dup', 'post', 'user'].includes(k)) continue; // k6 generates these
    env[k.toUpperCase()] = v;
  }

  k6Abort = new AbortController();
  $<HTMLButtonElement>('k6-run').disabled = true;
  $<HTMLButtonElement>('k6-stop').disabled = false;
  show(`k6 · ${t.label} · ${env.VUS} VUs`, '');
  try {
    const res = await fetch(`/api/k6?${new URLSearchParams(env)}`, { method: 'POST', signal: k6Abort.signal });
    if (!res.ok || !res.body) {
      output.textContent = JSON.stringify(await res.json().catch(() => ({ status: res.status })), null, 2);
      return;
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      output.textContent += value;
      output.scrollTop = output.scrollHeight;
    }
  } catch (err) {
    output.textContent += `\n[${(err as Error).name === 'AbortError' ? 'stopped' : String(err)}]\n`;
  } finally {
    k6Abort = null;
    $<HTMLButtonElement>('k6-run').disabled = false;
    $<HTMLButtonElement>('k6-stop').disabled = true;
  }
}

// ----------------------------------------------------------------- wire --

/** A select option that explains itself on hover. */
const helpOption = (label: string, value: string, help: string | undefined): HTMLOptionElement => {
  const o = new Option(label, value);
  if (help) o.title = help;
  return o;
};
for (const t of TESTS) testSel.append(helpOption(t.label, t.id, t.help));
for (const k of Object.keys(INDEX_HELP)) $<HTMLSelectElement>('index-kind').append(helpOption(k, k, INDEX_HELP[k]));
for (const t of Object.keys(TABLE_HELP)) $<HTMLSelectElement>('reset-table').append(helpOption(t, t, TABLE_HELP[t]));
// The two maintenance selects also explain the current choice on the select itself.
for (const [id, help] of [['index-kind', INDEX_HELP], ['reset-table', TABLE_HELP]] as const) {
  const sel = $<HTMLSelectElement>(id);
  const update = (): void => tip(sel, help[sel.value] ?? '');
  sel.addEventListener('change', update);
  update();
}
applyStaticTips();
renderFields(k6FieldsEl, K6_FIELDS, k6Values, () => {});

dbSel.addEventListener('change', () => void loadStatus());
testSel.addEventListener('change', renderTest);
$('execute').addEventListener('click', () => void call(currentTest().method, requestUrl()));
$('k6-run').addEventListener('click', () => void runK6());
$('k6-stop').addEventListener('click', () => k6Abort?.abort());
$('clear').addEventListener('click', () => show('Response', ''));
// Refresh the status line afterwards, so the index badges show what exists now.
$('index-create').addEventListener('click', async () => {
  await call('POST', `/${dbSel.value}/index/${$<HTMLSelectElement>('index-kind').value}`);
  await loadStatus();
});
$('index-drop').addEventListener('click', async () => {
  await call('DELETE', `/${dbSel.value}/index/${$<HTMLSelectElement>('index-kind').value}`);
  await loadStatus();
});
$('reset').addEventListener('click', () => void call('POST', `/${dbSel.value}/reset/${$<HTMLSelectElement>('reset-table').value}`));
$('verify').addEventListener('click', () => void call('GET', `/${dbSel.value}/verify`));
$('init').addEventListener('click', async () => {
  const btn = $<HTMLButtonElement>('init');
  btn.disabled = true;
  const db = dbSel.value;
  try {
    show(`POST /${db}/initialize`, [
      `Reinitializing ${db} from scratch:`,
      '  1. docker compose down -v      remove the old container and all its data',
      '  2. docker compose up -d --wait  start a fresh container, wait until healthy',
      '  3. create the schema and load the seed files',
      '  4. build the baseline indexes, then every search index this engine supports',
      '',
      'This can take a minute or more (longer if the image has to be pulled)…',
    ].join('\n'));
    $('db-status').textContent = 'recreating…';
    await call('POST', `/${db}/initialize`);
  } finally {
    btn.disabled = false;
    await loadStatus();
  }
});

// Tabs: the single-test panels vs the suite panel. The Response window is shared.
function setTab(tab: 'single' | 'suite'): void {
  const suite = tab === 'suite';
  for (const id of ['panel-single', 'single-metrics', 'history-card']) $(id).classList.toggle('hidden', suite);
  $('panel-suite').classList.toggle('hidden', !suite);
  // Progress and results stay hidden until a suite has run.
  for (const id of ['s-progress', 's-results-card']) {
    if (!suite) $(id).classList.add('hidden');
    else if (document.getElementById('s-results')!.childElementCount) $(id).classList.remove('hidden');
  }
  const on = 'rounded-lg bg-slate-700 px-3 py-1.5 text-white';
  const off = 'rounded-lg px-3 py-1.5 text-slate-400 hover:text-slate-200';
  $('tab-single').className = suite ? off : on;
  $('tab-suite').className = suite ? on : off;
  try {
    localStorage.setItem('bench.tab', tab);
  } catch {
    /* ignore */
  }
}
$('tab-single').addEventListener('click', () => setTab('single'));
$('tab-suite').addEventListener('click', () => setTab('suite'));

// Stacked layout: the output sits below the controls, so bring it into view when a run starts.
const stacked = matchMedia('(max-width: 1023px)');
for (const id of ['execute', 'k6-run', 's-run', 'init', 'index-create', 'index-drop', 'reset', 'verify']) {
  $(id).addEventListener('click', () => {
    if (stacked.matches) $('output-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

// Accordions: each control card folds on its heading; the first child is the header
// row, everything after it is the body. Collapsed set is remembered per heading.
const FOLD_KEY = 'bench.collapsed';
let collapsed = new Set<string>();
try {
  collapsed = new Set(JSON.parse(localStorage.getItem(FOLD_KEY) ?? '[]') as string[]);
} catch {
  /* ignore */
}
for (const card of document.querySelectorAll<HTMLElement>('#panel-single > .rounded-xl, #panel-suite > .rounded-xl')) {
  const h2 = card.querySelector('h2')!;
  const key = h2.textContent!.trim();
  const apply = (closed: boolean): void => {
    card.classList.toggle('collapsed', closed);
    h2.setAttribute('aria-expanded', String(!closed));
  };
  h2.classList.add('fold');
  h2.tabIndex = 0;
  h2.setAttribute('role', 'button');
  apply(collapsed.has(key));
  const toggle = (): void => {
    const closed = !card.classList.contains('collapsed');
    apply(closed);
    if (closed) collapsed.add(key);
    else collapsed.delete(key);
    try {
      localStorage.setItem(FOLD_KEY, JSON.stringify([...collapsed]));
    } catch {
      /* ignore */
    }
  };
  h2.addEventListener('click', toggle);
  h2.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    }
  });
}

const api = (await fetch('/api/config').then((r) => r.json())) as ApiConfig;
$('profile').textContent = `profile ${api.profile}`;
for (const db of api.databases) dbSel.append(helpOption(db, db, DB_HELP[db]));
// The database select describes the selected engine.
const dbTip = (): void => tip(dbSel, DB_HELP[dbSel.value] ?? '');
dbSel.addEventListener('change', dbTip);
dbTip();
initSuite(
  api,
  output,
  (t) => ($('out-title').textContent = t),
  Object.fromEntries(TESTS.map((t) => [t.id, `${t.label}\n${t.help}`])),
);
let savedTab: string | null = null;
try {
  savedTab = localStorage.getItem('bench.tab');
} catch {
  /* ignore */
}
setTab(savedTab === 'suite' ? 'suite' : 'single');
await loadStatus();
