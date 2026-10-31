/**
 * Reads bench.config.json for the server. The file is sparse: anything it
 * leaves out falls back to DEFAULTS, and BENCH_PROFILE (or --profile) layers a
 * named profile on top. Sizes may be numbers or strings like "10k" / "1M".
 *
 * Only what the server and k6 actually need is resolved here.
 */

import { PATHS } from './paths.ts';

type Obj = Record<string, unknown>;

export interface DocShape {
  topLevelFields: number;
  nestedDepth: number;
  arraySize: number;
}

export const SHAPE_NAMES = ['simple', 'single-join', 'multi-join'] as const;
export const MODE_NAMES = ['limit', 'offset', 'cursor'] as const;

export interface ServerConfig {
  profile: string;
  concurrency: number[];
  limits: number[];
  shapes: (typeof SHAPE_NAMES)[number][];
  readModes: (typeof MODE_NAMES)[number][];
  run: { durationSec: number; warmupSec: number };
  dataset: {
    users: number;
    posts: number;
    likes: number;
    documents: number;
    seed: number;
    loadChunk: number;
  };
  writes: {
    w1: { rowsPerCell: number };
    w2: { rowsPerCell: number; duplicateRatio: number; seedRows: number };
    w3: { batchSizes: number[]; maxRowsPerCell: number };
    w4: { rowsPerCell: number };
  };
  reads: {
    r3: { scoreCutoff: number };
    r4: { maxPages: number };
    r5: { multiGetSizes: number[]; hotKey: { enabled: boolean; hotKeys: number; hotTraffic: number } };
    r7: { countRangeFraction: number };
    r8: { fullSortRowCap: number };
    r10: { docShape: DocShape };
  };
}

const DEFAULTS: Obj = {
  concurrency: [1, 2, 8, 32, 64],
  limits: ['100', '1k', '3k', '5k', '10k', '20k'],
  shapes: [...SHAPE_NAMES],
  readModes: [...MODE_NAMES],
  run: { durationSec: 3, warmupSec: 1 },
  dataset: { users: '100k', posts: '300k', likes: '1M', documents: '50k', seed: 42, loadChunk: 5000 },
  writes: {
    w1: { rowsPerCell: '20k' },
    w2: { rowsPerCell: '20k', duplicateRatio: 0.1, seedRows: 1000 },
    w3: { batchSizes: ['1k', '10k', '30k', '50k', '100k'], maxRowsPerCell: '1M' },
    w4: { rowsPerCell: '20k' },
  },
  reads: {
    r3: { scoreCutoff: 500000 },
    r4: { maxPages: 1000 },
    r5: { multiGetSizes: [100, 1000], hotKey: { enabled: true, hotKeys: 0.2, hotTraffic: 0.8 } },
    r7: { countRangeFraction: 0.1 },
    r8: { fullSortRowCap: '50k' },
    r10: { docShape: { topLevelFields: 4, nestedDepth: 2, arraySize: 5 } },
  },
};

export const CONFIG_PATH = PATHS.config;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? merge(b, v) : v;
  }
  return out;
}

export function size(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(v);
    if (m) {
      const unit = (m[2] ?? '').toLowerCase();
      return Math.round(Number(m[1]) * (unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1));
    }
  }
  throw new Error(`config: ${where} must be a number or a size like "10k" (got ${JSON.stringify(v)})`);
}

const sizes = (v: unknown, where: string): number[] => {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`config: ${where} must be a non-empty list`);
  return v.map((x, i) => size(x, `${where}[${i}]`));
};

const obj = (v: unknown, where: string): Obj => {
  if (!isObj(v)) throw new Error(`config: ${where} must be an object`);
  return v;
};

function pick<T extends string>(v: unknown, allowed: readonly T[], where: string): T[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`config: ${where} must be a non-empty list`);
  for (const x of v) {
    if (!allowed.includes(x as T)) throw new Error(`config: ${where} has "${String(x)}"; allowed: ${allowed.join(', ')}`);
  }
  return [...new Set(v as T[])];
}

/**
 * Config for `profile`, with `overrides` (same shape as bench.config.json)
 * merged on top -- the suite endpoint's per-run matrix choices.
 */
export async function loadConfig(
  profile = process.env.BENCH_PROFILE ?? 'standard',
  overrides: Obj = {},
): Promise<ServerConfig> {
  let raw: Obj = DEFAULTS;
  const file = Bun.file(CONFIG_PATH);
  let profiles: Obj = {};
  if (await file.exists()) {
    const parsed: unknown = await file.json();
    if (!isObj(parsed)) throw new Error(`${CONFIG_PATH} must contain a JSON object`);
    profiles = isObj(parsed.profiles) ? parsed.profiles : {};
    raw = merge(raw, parsed);
  }
  if (profile !== 'standard' || isObj(profiles.standard)) {
    const overlay = profiles[profile];
    if (overlay === undefined && profile !== 'standard') {
      throw new Error(`unknown profile "${profile}"; available: ${Object.keys(profiles).join(', ')}`);
    }
    if (isObj(overlay)) raw = merge(raw, overlay);
  }
  raw = merge(raw, overrides);

  const ds = obj(raw.dataset, 'dataset');
  const run = obj(raw.run, 'run');
  const w = obj(raw.writes, 'writes');
  const r = obj(raw.reads, 'reads');
  const r5 = obj(r.r5, 'reads.r5');
  const hot = obj(r5.hotKey, 'reads.r5.hotKey');
  const doc = obj(obj(r.r10, 'reads.r10').docShape, 'reads.r10.docShape');
  const w2 = obj(w.w2, 'writes.w2');
  const w3 = obj(w.w3, 'writes.w3');

  const cfg: ServerConfig = {
    profile,
    concurrency: sizes(raw.concurrency, 'concurrency'),
    limits: [...new Set(sizes(raw.limits, 'limits'))].sort((a, b) => a - b),
    shapes: pick(raw.shapes, SHAPE_NAMES, 'shapes'),
    readModes: pick(raw.readModes, MODE_NAMES, 'readModes'),
    run: { durationSec: Number(run.durationSec), warmupSec: Number(run.warmupSec) },
    dataset: {
      users: size(ds.users, 'dataset.users'),
      posts: size(ds.posts, 'dataset.posts'),
      likes: size(ds.likes, 'dataset.likes'),
      documents: size(ds.documents, 'dataset.documents'),
      seed: Number(ds.seed),
      loadChunk: size(ds.loadChunk, 'dataset.loadChunk'),
    },
    writes: {
      w1: { rowsPerCell: size(obj(w.w1, 'writes.w1').rowsPerCell, 'writes.w1.rowsPerCell') },
      w2: {
        rowsPerCell: size(w2.rowsPerCell, 'writes.w2.rowsPerCell'),
        duplicateRatio: Number(w2.duplicateRatio),
        seedRows: size(w2.seedRows, 'writes.w2.seedRows'),
      },
      w3: {
        batchSizes: sizes(w3.batchSizes, 'writes.w3.batchSizes'),
        maxRowsPerCell: size(w3.maxRowsPerCell, 'writes.w3.maxRowsPerCell'),
      },
      w4: { rowsPerCell: size(obj(w.w4, 'writes.w4').rowsPerCell, 'writes.w4.rowsPerCell') },
    },
    reads: {
      r3: { scoreCutoff: size(obj(r.r3, 'reads.r3').scoreCutoff, 'reads.r3.scoreCutoff') },
      r4: { maxPages: size(obj(r.r4, 'reads.r4').maxPages, 'reads.r4.maxPages') },
      r5: {
        multiGetSizes: sizes(r5.multiGetSizes, 'reads.r5.multiGetSizes'),
        hotKey: { enabled: Boolean(hot.enabled), hotKeys: Number(hot.hotKeys), hotTraffic: Number(hot.hotTraffic) },
      },
      r7: { countRangeFraction: Number(obj(r.r7, 'reads.r7').countRangeFraction) },
      r8: { fullSortRowCap: size(obj(r.r8, 'reads.r8').fullSortRowCap, 'reads.r8.fullSortRowCap') },
      r10: {
        docShape: {
          topLevelFields: Number(doc.topLevelFields),
          nestedDepth: Number(doc.nestedDepth),
          arraySize: Number(doc.arraySize),
        },
      },
    },
  };

  // Planting is a seed concern. A run that overrides limits keeps the seed's planted
  // blocks, and R9/R10 only run the limits the seed planted.
  const planted = cfg.limits.reduce((a, b) => a + b, 0);
  if (!overrides.limits && (cfg.dataset.users < planted || cfg.dataset.documents < planted)) {
    throw new Error(
      `config: dataset.users and dataset.documents must each be at least the sum of the limits (${planted}), ` +
        'because text-search and JSON tests plant one block of matching rows per limit',
    );
  }
  return cfg;
}

/** Connection settings per engine, overridable by env. Defaults match src/databases/<engine>/docker-compose.yml. */
export const CONNECTIONS = {
  postgres: { host: env('PG_HOST', 'localhost'), port: num('PG_PORT', 5432), user: 'postgres', password: 'postgres', database: 'benchmark' },
  cockroachdb: { host: env('CRDB_HOST', 'localhost'), port: num('CRDB_PORT', 26257), user: 'root', password: '', database: 'benchmark' },
  mysql: { host: env('MYSQL_HOST', 'localhost'), port: num('MYSQL_PORT', 3306), user: 'benchmark', password: 'benchmark', database: 'benchmark' },
  mssql: { host: env('MSSQL_HOST', 'localhost'), port: num('MSSQL_PORT', 1433), user: 'sa', password: 'Benchmark_Pass1', database: 'benchmark' },
  // directConnection, not replicaSet=rs0: a single-node set in Docker advertises a hostname the host often can't reach.
  mongodb: { url: env('MONGO_URL', 'mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=10000'), database: 'benchmark' },
  cassandra: { host: env('CASSANDRA_HOST', 'localhost'), port: num('CASSANDRA_PORT', 9042), datacenter: env('CASSANDRA_DC', 'datacenter1'), keyspace: 'benchmark' },
  elasticsearch: { url: env('ES_URL', 'http://localhost:9200') },
} as const;

/** Pool size for every engine. Must be at least the highest k6 concurrency level. */
export const POOL_SIZE = num('POOL_SIZE', 64);

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function num(name: string, fallback: number): number {
  const v = process.env[name];
  return v === undefined ? fallback : Number(v);
}
