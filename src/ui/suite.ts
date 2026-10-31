/**
 * Suite tab: pick databases, tests and the matrix, then stream a whole run
 * from POST /api/suite into the Response window, with a progress bar and a
 * results table. Uses the same event formatter as suite/cli.ts, so the page
 * prints exactly what the terminal client prints. Choices persist in
 * localStorage (this browser only; bench.config.json is never written).
 */

import { formatEvent, type Compact, type Level, type SuiteEvent } from '../suite/events.ts';
import { DB_HELP, MODE_HELP, SHAPE_HELP, TIMING_HELP, tip } from './help.ts';

export interface ApiConfig {
  profile: string;
  tests: string[];
  databases: string[];
  config: {
    concurrency: number[];
    limits: number[];
    shapes: string[];
    readModes: string[];
    run: { durationSec: number; warmupSec: number };
  };
  /** The per-run settings the advanced box starts with (writes.*, reads.r4, reads.r5). */
  editable: Record<string, unknown>;
}

interface Saved {
  dbs: string[];
  tests: string[];
  concurrency: string;
  limits: string;
  shapes: string[];
  modes: string[];
  duration: string;
  warmup: string;
  init: boolean;
  indexes: boolean;
  verbose: boolean;
  /** Apply the advanced JSON to the run; off means it is ignored entirely. */
  advancedOn: boolean;
  advanced: string;
}

const STORE_KEY = 'bench.suite.v1';
const ALL_SHAPES = ['simple', 'single-join', 'multi-join'];
const ALL_MODES = ['limit', 'offset', 'cursor'];
const MAX_LINES = 6000;

const LEVEL_CLASS: Record<Level, string> = {
  info: 'text-slate-300',
  head: 'text-white font-semibold',
  ok: 'text-emerald-300',
  na: 'text-amber-300',
  fail: 'text-rose-400',
  raw: 'text-slate-500',
};

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

/** What a suite runs for each test, shown under its description in the tooltip. */
const SUITE_SCOPE: Record<string, string> = {
  r1: 'Suite: every shape × read mode × limit.',
  r2: 'Suite: every shape × read mode × limit.',
  r3: 'Suite: every shape × read mode × limit.',
  r4: 'Suite: every shape × offset/cursor × limit, each VU walking up to reads.r4.maxPages pages.',
  r5: 'Suite: id lookup per shape (uniform, plus the 80/20 hot-key variant), and multi-get per reads.r5.multiGetSizes.',
  r6: 'Suite: every shape × read mode × limit.',
  r7: 'Suite: all 7 aggregates (counts, SUM, posts per user, likes per post, likes per user).',
  r8: 'Suite: top-N per shape × indexed/unindexed key × limit, plus one capped full sort.',
  r9: 'Suite: prefix / contains / suffix with no index, prefix with an index, and full-text, at each planted limit.',
  r10: 'Suite: top-level / nested / array filters, each without and with its index, at each planted limit.',
  w1: 'Suite: writes.w1.rowsPerCell inserts split across the VUs.',
  w2: 'Suite: writes.w2.rowsPerCell inserts; duplicateRatio of them hit the unique key on purpose.',
  w3: 'Suite: one cell per batch size in writes.w3.batchSizes, up to maxRowsPerCell rows.',
  w4: 'Suite: writes.w4.rowsPerCell JSON document inserts.',
  like: 'Suite: uniform and hot contention; the integrity check runs at the end of each.',
};

function checkboxes(
  container: HTMLElement,
  name: string,
  items: string[],
  checked: string[],
  onChange: () => void,
  titles: Record<string, string> = {},
): void {
  container.replaceChildren();
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'flex items-center gap-2';
    if (titles[item]) {
      label.title = titles[item];
      label.classList.add('cursor-help');
    }
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.name = name;
    box.value = item;
    box.checked = checked.includes(item);
    box.className = 'accent-indigo-500';
    box.addEventListener('change', onChange);
    label.append(box, document.createTextNode(item));
    container.append(label);
  }
}

const checked = (name: string): string[] =>
  [...document.querySelectorAll<HTMLInputElement>(`input[name="${name}"]:checked`)].map((b) => b.value);

const csv = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/**
 * @param describe per test id, the label and description the Single tab shows
 *   (shared so the two tabs never describe a test differently)
 */
export function initSuite(
  api: ApiConfig,
  output: HTMLElement,
  setTitle: (t: string) => void,
  describe: Record<string, string> = {},
): void {
  const testTitles = Object.fromEntries(
    api.tests.map((t) => [t, [describe[t], SUITE_SCOPE[t]].filter(Boolean).join('\n\n')]),
  );
  const cfg = api.config;
  const editableJson = (): string => JSON.stringify(api.editable, null, 2);
  const defaults = (): Saved => ({
    dbs: [api.databases[0] ?? 'postgres'],
    tests: [...api.tests],
    concurrency: cfg.concurrency.join(','),
    limits: cfg.limits.join(','),
    shapes: cfg.shapes,
    modes: cfg.readModes,
    duration: String(cfg.run.durationSec),
    warmup: String(cfg.run.warmupSec),
    init: true,
    indexes: true,
    verbose: false,
    advancedOn: false,
    advanced: editableJson(),
  });

  let saved: Saved = defaults();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) saved = { ...saved, ...(JSON.parse(raw) as Partial<Saved>) };
  } catch {
    /* storage unavailable: use the config defaults */
  }
  // An empty box (or one saved before it was pre-filled) shows the config values.
  if (!saved.advanced.trim()) saved.advanced = editableJson();

  const inputs = {
    concurrency: $<HTMLInputElement>('s-concurrency'),
    limits: $<HTMLInputElement>('s-limits'),
    duration: $<HTMLInputElement>('s-duration'),
    warmup: $<HTMLInputElement>('s-warmup'),
    init: $<HTMLInputElement>('s-init'),
    indexes: $<HTMLInputElement>('s-indexes'),
    verbose: $<HTMLInputElement>('s-verbose'),
    advancedOn: $<HTMLInputElement>('s-adv-on'),
    advanced: $<HTMLTextAreaElement>('s-advanced'),
  };

  // Hover help on the timing fields (the label wraps the input, so it covers both).
  tip(inputs.duration.closest('label'), TIMING_HELP.duration);
  tip(inputs.warmup.closest('label'), TIMING_HELP.warmup);
  tip(inputs.concurrency.closest('label'), `Concurrency levels: comma-separated VU counts; every cell runs once at each.\n\n${TIMING_HELP.vus}`);

  /** Dim the box while it is off, and say whether it differs from the config. */
  function showAdvancedState(): void {
    const on = inputs.advancedOn.checked;
    inputs.advanced.classList.toggle('opacity-50', !on);
    let edited = true;
    try {
      edited = JSON.stringify(JSON.parse(inputs.advanced.value)) !== JSON.stringify(api.editable);
    } catch {
      /* invalid JSON counts as edited */
    }
    const state = $('s-adv-state');
    state.textContent = !on
      ? `not applied${edited ? ' (edited, tick the box to use it)' : ''}`
      : edited ? 'applied to the next run' : 'applied, but identical to the config';
    state.className = on && edited ? 'text-indigo-300' : 'text-slate-500';
  }

  function render(s: Saved): void {
    checkboxes($('s-dbs'), 's-db', api.databases, s.dbs, changed, DB_HELP);
    checkboxes($('s-tests'), 's-test', api.tests, s.tests, changed, testTitles);
    checkboxes($('s-shapes'), 's-shape', ALL_SHAPES, s.shapes, changed, SHAPE_HELP);
    checkboxes($('s-modes'), 's-mode', ALL_MODES, s.modes, changed, MODE_HELP);
    inputs.concurrency.value = s.concurrency;
    inputs.limits.value = s.limits;
    inputs.duration.value = s.duration;
    inputs.warmup.value = s.warmup;
    inputs.init.checked = s.init;
    inputs.indexes.checked = s.indexes;
    inputs.indexes.disabled = !s.init;
    inputs.verbose.checked = s.verbose;
    inputs.advancedOn.checked = s.advancedOn;
    inputs.advanced.value = s.advanced;
    showAdvancedState();
  }

  function current(): Saved {
    return {
      dbs: checked('s-db'),
      tests: checked('s-test'),
      concurrency: inputs.concurrency.value,
      limits: inputs.limits.value,
      shapes: checked('s-shape'),
      modes: checked('s-mode'),
      duration: inputs.duration.value,
      warmup: inputs.warmup.value,
      init: inputs.init.checked,
      indexes: inputs.indexes.checked,
      verbose: inputs.verbose.checked,
      advancedOn: inputs.advancedOn.checked,
      advanced: inputs.advanced.value,
    };
  }

  /** The POST body. Throws with a readable message on bad input. */
  function request(s: Saved): Record<string, unknown> {
    // The advanced box is ignored entirely unless it is switched on.
    let advanced: Record<string, unknown> = {};
    if (s.advancedOn && s.advanced.trim()) {
      try {
        advanced = JSON.parse(s.advanced) as Record<string, unknown>;
      } catch {
        throw new Error('advanced overrides are not valid JSON');
      }
    }
    // Form fields win over the advanced JSON for the keys they own.
    const overrides: Record<string, unknown> = {
      ...advanced,
      concurrency: csv(s.concurrency).map(Number),
      limits: csv(s.limits),
      shapes: s.shapes,
      readModes: s.modes,
      run: { ...((advanced.run as object) ?? {}), durationSec: Number(s.duration), warmupSec: Number(s.warmup) },
    };
    return { dbs: s.dbs, tests: s.tests, initialize: s.init, indexes: s.indexes, verbose: s.verbose, overrides };
  }

  // ---------------------------------------------------------------- plan --

  let planTimer: ReturnType<typeof setTimeout> | undefined;
  const planEl = $('s-plan');

  async function refreshPlan(): Promise<void> {
    const s = current();
    if (!s.dbs.length || !s.tests.length) {
      planEl.textContent = 'Pick at least one database and one test.';
      planEl.className = planEl.className.replace(/text-\S+-\d+/, 'text-amber-300');
      return;
    }
    try {
      const res = await fetch('/api/suite/plan', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request(s)),
      });
      const body = (await res.json()) as SuiteEvent & { message?: string };
      if (!res.ok || body.type !== 'plan') throw new Error(body.message ?? `HTTP ${res.status}`);
      const per = body.dbs.map((d) => `${d.db} ${d.runs}${d.na ? ` (${d.na} N/A)` : ''}`).join(' · ');
      planEl.textContent = `${body.runs} k6 runs — ${per}. Timed reads alone ≈ ${Math.ceil(body.timedMinutes)} min, plus writes and R4 walks.`;
      planEl.className = planEl.className.replace(/text-\S+-\d+/, 'text-slate-300');
    } catch (err) {
      planEl.textContent = (err as Error).message;
      planEl.className = planEl.className.replace(/text-\S+-\d+/, 'text-rose-400');
    }
  }

  function changed(): void {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(current()));
    } catch {
      /* storage unavailable: the choices just won't persist */
    }
    clearTimeout(planTimer);
    planTimer = setTimeout(() => void refreshPlan(), 350);
  }

  for (const el of Object.values(inputs)) el.addEventListener('input', changed);
  inputs.advancedOn.addEventListener('change', showAdvancedState);
  inputs.advanced.addEventListener('input', showAdvancedState);
  $('s-adv-reset').addEventListener('click', () => {
    inputs.advanced.value = editableJson();
    showAdvancedState();
    changed();
  });
  // Search indexes are built by initialize, so the option only applies with it on.
  inputs.init.addEventListener('change', () => (inputs.indexes.disabled = !inputs.init.checked));
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-pick]')) {
    btn.addEventListener('click', () => {
      const pick = btn.dataset.pick;
      for (const box of document.querySelectorAll<HTMLInputElement>('input[name="s-test"]')) {
        box.checked = pick === 'all' || (pick === 'reads' && box.value.startsWith('r'))
          || (pick === 'writes' && !box.value.startsWith('r'));
      }
      changed();
    });
  }
  $('s-defaults').addEventListener('click', () => {
    const d = defaults();
    render({ ...d, dbs: checked('s-db').length ? checked('s-db') : d.dbs });
    changed();
  });

  // ------------------------------------------------------------- output --

  function append(level: Level, text: string): void {
    const span = document.createElement('span');
    span.className = LEVEL_CLASS[level];
    span.textContent = `${text}\n`;
    output.append(span);
    while (output.childNodes.length > MAX_LINES) output.firstChild?.remove();
    output.scrollTop = output.scrollHeight;
  }

  const n = (v: number | undefined): string => (v === undefined ? '' : v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 100) / 100));
  const resultsBody = $('s-results');
  const filter = $<HTMLInputElement>('s-filter');

  function applyFilter(row: HTMLTableRowElement): void {
    const terms = filter.value.toLowerCase().split(/\s+/).filter(Boolean);
    const text = row.dataset.key ?? '';
    row.hidden = terms.some((t) => !text.includes(t));
  }
  filter.addEventListener('input', () => {
    for (const row of resultsBody.querySelectorAll('tr')) applyFilter(row);
  });

  function resultRow(db: string, cell: string, vus: number, c: Compact | null, failed?: string): void {
    const tr = document.createElement('tr');
    tr.dataset.key = `${db} ${cell} ${vus}`.toLowerCase();
    const cells = c
      ? [db, cell, vus, n(c.reqs?.rate), n(c.http_req_duration?.med), n(c.http_req_duration?.['p(95)']),
          n(c.http_req_duration?.['p(99)']), n(c.db_ms?.med), n(c.db_ms?.['p(95)']), n(c.rows?.avg), n(c.errors?.count) || '0']
      : [db, cell, vus, failed ?? 'failed', '', '', '', '', '', '', ''];
    cells.forEach((v, i) => {
      const td = document.createElement('td');
      td.className = `px-3 py-1.5 ${i >= 2 ? 'text-right tabular-nums' : ''} ${i === 1 ? 'font-mono' : ''}`;
      if (!c && i === 3) td.className += ' text-rose-400 text-left';
      if (i === 7 || i === 8) td.className += ' text-indigo-300';
      td.textContent = String(v);
      tr.append(td);
    });
    applyFilter(tr);
    resultsBody.append(tr);
  }

  // ---------------------------------------------------------------- run --

  let abort: AbortController | null = null;
  const counts = { ok: 0, na: 0, failed: 0 };

  function progress(index: number, total: number, label: string): void {
    $('s-progress-count').textContent = `${index} / ${total}`;
    $('s-progress-bar').style.width = `${total ? (index / total) * 100 : 0}%`;
    $('s-progress-label').textContent = label;
  }

  function setCounts(): void {
    $('s-ok').textContent = String(counts.ok);
    $('s-na').textContent = String(counts.na);
    $('s-failed').textContent = String(counts.failed);
  }

  function handle(e: SuiteEvent): void {
    const f = formatEvent(e);
    if (f) append(f.level, f.text);
    switch (e.type) {
      case 'plan':
        progress(0, e.runs, `run ${e.runId}`);
        break;
      case 'cell-start':
        progress(e.index - 1, e.total, `${e.db} · ${e.cell} @ ${e.vus}`);
        break;
      case 'cell-result':
        counts.ok++;
        progress(e.index, e.total, `${e.db} · ${e.cell} @ ${e.vus}`);
        resultRow(e.db, e.cell, e.vus, e.compact);
        break;
      case 'cell-failed':
        counts.failed++;
        progress(e.index, e.total, `${e.db} · ${e.cell} @ ${e.vus}`);
        resultRow(e.db, e.cell, e.vus, null, e.reason);
        break;
      case 'cell-na':
        counts.na++;
        break;
      case 'done': {
        const link = $<HTMLAnchorElement>('s-summary');
        link.href = `/api/runs/${e.runId}/summary`;
        link.classList.remove('hidden');
        const open = $<HTMLAnchorElement>('s-open');
        open.href = `/results#run=${encodeURIComponent(e.runId)}`;
        open.classList.remove('hidden');
        $('s-progress-label').textContent = e.aborted ? 'stopped' : 'done';
        break;
      }
    }
    setCounts();
  }

  async function run(): Promise<void> {
    const s = current();
    let body: Record<string, unknown>;
    try {
      body = request(s);
    } catch (err) {
      planEl.textContent = (err as Error).message;
      return;
    }
    output.replaceChildren();
    resultsBody.replaceChildren();
    Object.assign(counts, { ok: 0, na: 0, failed: 0 });
    setCounts();
    $('s-summary').classList.add('hidden');
    $('s-open').classList.add('hidden');
    $('s-progress').classList.remove('hidden');
    $('s-results-card').classList.remove('hidden');
    setTitle(`Suite · ${s.dbs.join(', ')}`);
    progress(0, 0, 'starting…');

    abort = new AbortController();
    $<HTMLButtonElement>('s-run').disabled = true;
    $<HTMLButtonElement>('s-stop').disabled = false;
    try {
      const res = await fetch('/api/suite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const err = (await res.json().catch(() => ({}))) as { message?: string };
        append('fail', `${res.status}: ${err.message ?? 'request failed'}`);
        return;
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let rest = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        rest += value;
        const lines = rest.split('\n');
        rest = lines.pop() ?? '';
        for (const line of lines) if (line) handle(JSON.parse(line) as SuiteEvent);
      }
    } catch (err) {
      append('fail', (err as Error).name === 'AbortError' ? '\nstopped — the server kills the k6 run in flight' : String(err));
      $('s-progress-label').textContent = 'stopped';
    } finally {
      abort = null;
      $<HTMLButtonElement>('s-run').disabled = false;
      $<HTMLButtonElement>('s-stop').disabled = true;
    }
  }

  $('s-run').addEventListener('click', () => void run());
  $('s-stop').addEventListener('click', () => abort?.abort());

  render(saved);
  void refreshPlan();
}
