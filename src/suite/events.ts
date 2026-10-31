/**
 * What POST /api/suite streams, one JSON object per line, and how each event
 * reads as a log line. Pure: imported by the server, by suite/cli.ts (terminal) and
 * by the browser UI, so all three print the same thing.
 */

export interface Stats {
  min?: number;
  avg?: number;
  med?: number;
  'p(95)'?: number;
  'p(99)'?: number;
  max?: number;
  count?: number;
  rate?: number;
}

/** The per-run numbers k6's summary handler writes (k6/lib.js `summary`). */
export interface Compact {
  vus: number;
  http_req_duration: Stats | null;
  db_ms: Stats | null;
  rows: Stats | null;
  reqs: Stats | null;
  uk_violations: Stats | null;
  errors: Stats | null;
}

/** Everything the run will do, sent before anything starts. */
export interface PlanEvent {
  type: 'plan';
  runId: string;
  profile: string;
  dbs: { db: string; cells: number; na: number; runs: number }[];
  runs: number;
  /** Timed read cells only; fixed-work writes and R4 walks depend on the engine. */
  timedMinutes: number;
}

export type SuiteEvent =
  | PlanEvent
  | { type: 'log'; text: string }
  | { type: 'db-start'; db: string; initialize: boolean }
  | { type: 'db-ready'; db: string; downMs?: number; upMs?: number; loadMs?: Record<string, number>; indexMs?: Record<string, number> }
  | { type: 'db-failed'; db: string; message: string }
  | { type: 'cell-start'; db: string; cell: string; vus: number; index: number; total: number }
  | { type: 'cell-result'; db: string; cell: string; vus: number; index: number; total: number; compact: Compact }
  | { type: 'cell-failed'; db: string; cell: string; vus: number; index: number; total: number; reason: string; tail: string }
  | { type: 'cell-na'; db: string; cell: string; reason: string }
  | { type: 'k6'; text: string }
  | { type: 'done'; runId: string; dir: string; ok: number; na: number; failed: number; aborted: boolean }
  | { type: 'error'; message: string };

export type Level = 'info' | 'head' | 'ok' | 'na' | 'fail' | 'raw';

const n = (v: number | undefined, digits = 2): string =>
  v === undefined ? '–' : v >= 100 ? Math.round(v).toLocaleString('en-US') : String(Math.round(v * 10 ** digits) / 10 ** digits);

const pad = (i: number, total: number): string => `[${String(i).padStart(String(total).length)}/${total}]`;

/** One event as a log line, or null for events that print nothing on their own. */
export function formatEvent(e: SuiteEvent): { level: Level; text: string } | null {
  switch (e.type) {
    case 'plan': {
      const per = e.dbs.map((d) => `${d.db}: ${d.cells} cells (${d.na} N/A), ${d.runs} runs`).join('\n  ');
      return {
        level: 'head',
        text: `run ${e.runId} (profile ${e.profile})\n  ${per}\n  ${e.runs} k6 runs; timed read cells alone ≈ ${Math.ceil(e.timedMinutes)} min`,
      };
    }
    case 'log':
      return { level: 'info', text: e.text };
    case 'db-start':
      return { level: 'head', text: `\n=== ${e.db} ===${e.initialize ? '\n  recreating container and loading seed…' : ''}` };
    case 'db-ready': {
      if (!e.loadMs) return { level: 'info', text: '  using the already-initialized database' };
      const idx = Object.entries(e.indexMs ?? {}).map(([k, ms]) => `${k} ${n(ms)} ms`).join(', ');
      return {
        level: 'info',
        text: `  container recreated (down ${n(e.downMs)} ms, up ${n(e.upMs)} ms); seed loaded in ${n(e.loadMs.total)} ms` +
          `\n  search indexes: ${idx || 'none'}`,
      };
    }
    case 'db-failed':
      return { level: 'fail', text: `  ${e.db} failed: ${e.message}` };
    case 'cell-start':
      return { level: 'info', text: `${pad(e.index, e.total)} ${e.cell} @ ${e.vus} VUs` };
    case 'cell-result': {
      const c = e.compact;
      const h = c.http_req_duration;
      const d = c.db_ms;
      const extra = [
        c.errors?.count ? `errors ${c.errors.count}` : '',
        c.uk_violations?.count ? `uk ${c.uk_violations.count}` : '',
      ].filter(Boolean).join(' · ');
      return {
        level: 'ok',
        text: `${' '.repeat(pad(e.index, e.total).length)} → ${n(c.reqs?.rate, 1)} req/s · http p50 ${n(h?.med)} / p95 ${n(h?.['p(95)'])} ms` +
          ` · db p50 ${n(d?.med)} / p95 ${n(d?.['p(95)'])} ms · rows ${n(c.rows?.avg, 0)}${extra ? ` · ${extra}` : ''}`,
      };
    }
    case 'cell-failed':
      return { level: 'fail', text: `${pad(e.index, e.total)} ${e.cell} @ ${e.vus} VUs FAILED: ${e.reason}${e.tail ? `\n${e.tail}` : ''}` };
    case 'cell-na':
      return { level: 'na', text: `  N/A ${e.cell}: ${e.reason}` };
    case 'k6':
      return { level: 'raw', text: e.text };
    case 'done':
      return {
        level: 'head',
        text: `\n${e.aborted ? 'stopped' : 'done'}: ${e.ok} ok, ${e.na} N/A, ${e.failed} failed\nresults in ${e.dir}`,
      };
    case 'error':
      return { level: 'fail', text: `error: ${e.message}` };
  }
}
