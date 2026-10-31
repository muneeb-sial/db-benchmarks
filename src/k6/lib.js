/**
 * Shared k6 helpers. One k6 run = one test cell at one concurrency level;
 * src/suite/cli.ts loops the matrix and the levels.
 *
 * Env (all optional except DB):
 *   DB          postgres | mysql | ...
 *   BASE_URL    default http://localhost:3000
 *   VUS         concurrency level (default 1)
 *   DURATION    measured seconds for timed reads (default 3)
 *   WARMUP      warmup seconds, excluded from results (default 1)
 *   OUT         path for the JSON summary
 *
 * Every measured request is tagged phase:measure. The summary reports
 * http_req_duration (end to end) and db_ms (the server's own timing of the
 * database call, from the Server-Timing header) for that phase only.
 */

import http from 'k6/http';
import { Counter, Trend } from 'k6/metrics';

export const DB = __ENV.DB;
if (!DB) throw new Error('set -e DB=<database>');
export const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
export const VUS = Number(__ENV.VUS || 1);
export const DURATION = Number(__ENV.DURATION || 3);
export const WARMUP = Number(__ENV.WARMUP || 1);

export const dbMs = new Trend('db_ms', true);
export const ukViolations = new Counter('uk_violations');
export const opErrors = new Counter('op_errors');
export const opRows = new Trend('op_rows');

const MEASURE = { phase: 'measure' };

/** Thresholds with no conditions make k6 report the phase:measure submetrics. */
const thresholds = {
  'http_req_duration{phase:measure}': [],
  'db_ms{phase:measure}': [],
  'op_rows{phase:measure}': [],
  'http_reqs{phase:measure}': [],
};

/** Timed read: a warmup scenario, then the measured one. */
export function timedOptions(tags) {
  const scenarios = {};
  if (WARMUP > 0) {
    scenarios.warmup = {
      executor: 'constant-vus', vus: VUS, duration: `${WARMUP}s`, tags: { ...tags, phase: 'warmup' },
    };
  }
  scenarios.measure = {
    executor: 'constant-vus', vus: VUS, duration: `${DURATION}s`, startTime: `${WARMUP}s`,
    tags: { ...tags, ...MEASURE },
  };
  return { scenarios, thresholds, setupTimeout: '30m', teardownTimeout: '30m', summaryTrendStats: STATS };
}

/** Fixed work: `iterations` operations shared across VUS workers. */
export function fixedOptions(tags, iterations) {
  return {
    scenarios: {
      measure: {
        executor: 'shared-iterations', vus: Math.min(VUS, iterations), iterations, maxDuration: '2h',
        tags: { ...tags, ...MEASURE },
      },
    },
    thresholds, setupTimeout: '30m', teardownTimeout: '30m', summaryTrendStats: STATS,
  };
}

/** Each VU runs the default function once (R4: one whole-table walk per VU). */
export function perVuOptions(tags) {
  return {
    scenarios: {
      measure: { executor: 'per-vu-iterations', vus: VUS, iterations: 1, maxDuration: '6h', tags: { ...tags, ...MEASURE } },
    },
    thresholds, setupTimeout: '30m', teardownTimeout: '30m', summaryTrendStats: STATS,
  };
}

const STATS = ['min', 'avg', 'med', 'p(95)', 'p(99)', 'max', 'count'];

function query(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
}

/**
 * One op request. Records db_ms from Server-Timing, op_rows from the body,
 * and counts 409 (unique violation) separately from real errors.
 */
/**
 * `endOn`: statuses that mean "stop here" rather than "error", e.g. R4's 501
 * when an offset walk reaches an engine's result window. They are neither
 * counted as op_errors nor as failed requests.
 */
export function op(method, path, params = {}, tags = {}, endOn = []) {
  const qs = query(params);
  const url = `${BASE}/${DB}/${path}${qs ? `?${qs}` : ''}`;
  const res = http.request(method, url, null, {
    tags: { name: `${DB}/${path}`, ...tags },
    responseCallback: http.expectedStatuses(200, 409, ...endOn),
  });
  const timing = /db;dur=([\d.]+)/.exec(res.headers['Server-Timing'] || '');
  if (timing) dbMs.add(Number(timing[1]), tags);
  if (res.status === 409) ukViolations.add(1, tags);
  else if (endOn.includes(res.status)) return { ok: false, ended: true, status: res.status, body: res.body };
  else if (res.status !== 200) {
    opErrors.add(1, tags);
    return { ok: false, status: res.status, body: res.body };
  }
  let body = {};
  try {
    body = res.json();
  } catch (_) {
    /* non-JSON body */
  }
  if (res.status === 200 && typeof body.rows === 'number') opRows.add(body.rows, tags);
  return { ok: res.status === 200, status: res.status, ...body };
}

/** Control-plane request (setup/teardown): tagged so it never lands in the measured numbers. */
export function control(method, path) {
  const res = http.request(method, `${BASE}/${DB}/${path}`, null, { tags: { phase: 'setup' } });
  if (res.status >= 400) throw new Error(`${method} /${DB}/${path} -> ${res.status} ${res.body}`);
  return res.json();
}

/** setup(): the seed manifest, so scripts can compute valid keys. Fails fast if not initialized. */
export function manifest() {
  const s = control('GET', 'status');
  if (!s.initialized) throw new Error(`${DB} is not initialized; POST /${DB}/initialize first`);
  return s.manifest;
}

/**
 * setup(): make sure search index `kind` exists. Returns true only if this run
 * had to build it, so restoreIndex() never drops an index initialize built.
 */
export function ensureIndex(kind) {
  if (!kind) return false;
  return control('POST', `index/${kind}`).changed === true;
}

/** teardown(): drop the index again only if ensureIndex() built it. */
export function restoreIndex(kind, built) {
  if (kind && built) control('DELETE', `index/${kind}`);
}

// --------------------------------------------- deterministic params (k6 copy) --

export function hash32(seed, i, salt) {
  let h = (seed ^ Math.imul(i | 0, 0x9e3779b1) ^ Math.imul(salt | 0, 0x85ebca6b)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export const emailOf = (id) => `user${id}@bench.test`;

/** Rows the shape returns before paging: users, posts or likes. */
export function spanFor(m, shape) {
  if (shape === 'single-join') return m.posts;
  if (shape === 'multi-join') return m.likes;
  return m.users;
}

/** Offset or cursor start for request `slot`, kept inside a result set of `span` rows. */
export function positionFor(seed, slot, span, limit) {
  const room = Math.max(1, span - limit);
  return hash32(seed, slot, 7) % room;
}

/** A globally unique request number, stable across VUs. */
export function slot(execMod) {
  return execMod.scenario.iterationInTest + 1;
}

/** Paged-read params for mode `mode`: offset or cursor start inside `span`. */
export function pageParams(m, mode, limit, span, n) {
  if (mode === 'offset') return { offset: positionFor(m.seed, n, span, limit) };
  if (mode === 'cursor') return { after: positionFor(m.seed, n, span, limit) };
  return {};
}

export function summary(data) {
  const pick = (name) => {
    const v = data.metrics[name] && data.metrics[name].values;
    return v ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, Math.round(x * 1000) / 1000])) : null;
  };
  const compact = {
    db: DB,
    vus: VUS,
    http_req_duration: pick('http_req_duration{phase:measure}'),
    db_ms: pick('db_ms{phase:measure}'),
    rows: pick('op_rows{phase:measure}'),
    reqs: pick('http_reqs{phase:measure}'),
    uk_violations: pick('uk_violations'),
    errors: pick('op_errors'),
  };
  const line = (label, v) =>
    v ? `${label.padEnd(18)} med ${v.med}  p95 ${v['p(95)']}  p99 ${v['p(99)']}  max ${v.max}  n ${v.count}\n` : '';
  const out = {
    stdout:
      `\n${DB} @ ${VUS} VUs\n` +
      line('http_req_duration', compact.http_req_duration) +
      line('db_ms', compact.db_ms) +
      (compact.reqs ? `throughput         ${compact.reqs.rate} req/s\n` : '') +
      (compact.errors ? `errors             ${compact.errors.count}\n` : '') +
      (compact.uk_violations ? `uk violations      ${compact.uk_violations.count}\n` : ''),
  };
  if (__ENV.OUT) out[__ENV.OUT] = JSON.stringify({ compact, full: data }, null, 2);
  return out;
}
