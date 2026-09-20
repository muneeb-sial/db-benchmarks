/**
 * Suite configuration.
 *
 * Every number from features.md (limits, concurrency, batch sizes, dataset
 * size, ...) lives here or in `bench.config.json`, never in test code. The JSON
 * file is sparse: anything it omits falls back to DEFAULTS below, and a named
 * profile (`--profile smoke`) is layered on top of that. The fully-resolved
 * result is recorded into every result.json so a run can be reproduced.
 *
 * Sizes may be written as numbers or as strings such as "100", "1k", "2M".
 */

import { readFile } from 'node:fs/promises';

export const Shape = {
  Simple: 'simple',
  SingleJoin: 'single-join',
  MultiJoin: 'multi-join',
} as const;
export type Shape = (typeof Shape)[keyof typeof Shape];

export const ReadMode = {
  Limit: 'limit',
  Offset: 'offset',
  Cursor: 'cursor',
} as const;
export type ReadMode = (typeof ReadMode)[keyof typeof ReadMode];

export const SHAPES: readonly Shape[] = [Shape.Simple, Shape.SingleJoin, Shape.MultiJoin];
export const READ_MODES: readonly ReadMode[] = [ReadMode.Limit, ReadMode.Offset, ReadMode.Cursor];

export interface DocShape {
  /** Extra scalar fields on the document root, besides `tag`. */
  topLevelFields: number;
  /** Depth of the nested object holding the nested-filter field. */
  nestedDepth: number;
  /** Elements in the `tags` array. */
  arraySize: number;
}

export interface SuiteConfig {
  concurrency: number[];
  limits: number[];
  shapes: Shape[];
  readModes: ReadMode[];

  run: { durationSec: number; warmupSec: number; repeats: number };

  dataset: {
    users: number;
    posts: number;
    likes: number;
    documents: number;
    seed: number;
    tablePrefix: string;
    /** Rows per bulk insert while seeding. */
    loadChunk: number;
  };

  guards: {
    /** Cells whose concurrency x rows-per-op exceeds this are skipped, not shrunk. */
    maxInFlightRows: number;
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
    r5: {
      multiGetSizes: number[];
      hotKey: { enabled: boolean; hotKeys: number; hotTraffic: number };
    };
    r7: { countRangeFraction: number };
    r8: { fullSortRowCap: number };
    r9: { fullText: boolean };
    r10: { docShape: DocShape };
  };

  reports: {
    r4Chart: { concurrency: number; pageSize: number };
    summaryConcurrency: number;
  };
}

/** Raw (JSON-shaped) defaults. Sizes stay strings here, exactly as a user would write them. */
const DEFAULTS: Record<string, unknown> = {
  concurrency: [1, 2, 8, 32, 64],
  limits: ['100', '1k', '3k', '5k', '10k', '20k'],
  shapes: ['simple', 'single-join', 'multi-join'],
  readModes: ['limit', 'offset', 'cursor'],

  run: { durationSec: 3, warmupSec: 1, repeats: 1 },

  dataset: {
    users: '100k',
    posts: '300k',
    likes: '1M',
    documents: '50k',
    seed: 42,
    tablePrefix: 'suite_',
    loadChunk: 5000,
  },

  guards: { maxInFlightRows: '5M' },

  writes: {
    w1: { rowsPerCell: '20k' },
    w2: { rowsPerCell: '20k', duplicateRatio: 0.1, seedRows: 1000 },
    w3: { batchSizes: ['1k', '10k', '30k', '50k', '100k'], maxRowsPerCell: '1M' },
    w4: { rowsPerCell: '20k' },
  },

  reads: {
    r3: { scoreCutoff: 500000 },
    r4: { maxPages: 1000 },
    r5: {
      multiGetSizes: [100, 1000],
      hotKey: { enabled: true, hotKeys: 0.2, hotTraffic: 0.8 },
    },
    r7: { countRangeFraction: 0.1 },
    r8: { fullSortRowCap: '50k' },
    r9: { fullText: true },
    r10: { docShape: { topLevelFields: 4, nestedDepth: 2, arraySize: 5 } },
  },

  reports: {
    r4Chart: { concurrency: 1, pageSize: '1k' },
    summaryConcurrency: 8,
  },

  profiles: {
    smoke: {
      concurrency: [1, 8],
      limits: ['100', '1k'],
      run: { durationSec: 1, warmupSec: 0 },
      dataset: { users: '5k', posts: '15k', likes: '50k', documents: '2k' },
      writes: {
        w1: { rowsPerCell: '1k' },
        w2: { rowsPerCell: '1k' },
        w3: { batchSizes: ['1k', '10k'], maxRowsPerCell: '20k' },
        w4: { rowsPerCell: '1k' },
      },
      reads: { r4: { maxPages: 50 }, r8: { fullSortRowCap: '2k' } },
      reports: { r4Chart: { pageSize: '100' } },
    },
    standard: {},
    full: { run: { durationSec: 10, warmupSec: 3, repeats: 3 }, reads: { r4: { maxPages: 100000 } } },
  },
};

export const DEFAULT_CONFIG_PATH = 'bench.config.json';

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Objects merge recursively; arrays and scalars replace. */
export function deepMerge(base: Obj, over: Obj): Obj {
  const out: Obj = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObj(b) && isObj(v) ? deepMerge(b, v) : v;
  }
  return out;
}

export function parseSize(v: unknown, where: string): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const m = /^\s*(\d+(?:\.\d+)?)\s*([kKmM]?)\s*$/.exec(v);
    if (m) {
      const unit = (m[2] ?? '').toLowerCase();
      const mult = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : 1;
      return Math.round(Number(m[1]) * mult);
    }
  }
  throw new Error(`config: ${where} must be a number or a size like "10k" (got ${JSON.stringify(v)})`);
}

function sizeList(v: unknown, where: string): number[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`config: ${where} must be a non-empty list`);
  return v.map((x, i) => parseSize(x, `${where}[${i}]`));
}

function pick<T extends string>(v: unknown, allowed: readonly T[], where: string): T[] {
  if (!Array.isArray(v) || v.length === 0) throw new Error(`config: ${where} must be a non-empty list`);
  for (const x of v) {
    if (!allowed.includes(x as T)) {
      throw new Error(`config: ${where} has "${String(x)}"; allowed: ${allowed.join(', ')}`);
    }
  }
  return v as T[];
}

function positive(n: number, where: string): number {
  if (!Number.isInteger(n) || n <= 0) throw new Error(`config: ${where} must be a positive integer (got ${n})`);
  return n;
}

function ratio(v: unknown, where: string): number {
  if (typeof v !== 'number' || v < 0 || v > 1) throw new Error(`config: ${where} must be a number from 0 to 1`);
  return v;
}

const o = (v: unknown, where: string): Obj => {
  if (!isObj(v)) throw new Error(`config: ${where} must be an object`);
  return v;
};

/** Turns merged raw JSON into the typed, validated config the suite runs on. */
export function resolveConfig(raw: Obj): SuiteConfig {
  const limits = sizeList(raw.limits, 'limits').map((n, i) => positive(n, `limits[${i}]`));
  const ds = o(raw.dataset, 'dataset');
  const run = o(raw.run, 'run');
  const w = o(raw.writes, 'writes');
  const r = o(raw.reads, 'reads');
  const r5 = o(r.r5, 'reads.r5');
  const hot = o(r5.hotKey, 'reads.r5.hotKey');
  const doc = o(o(r.r10, 'reads.r10').docShape, 'reads.r10.docShape');
  const rep = o(raw.reports, 'reports');
  const chart = o(rep.r4Chart, 'reports.r4Chart');

  const cfg: SuiteConfig = {
    concurrency: sizeList(raw.concurrency, 'concurrency').map((n, i) => positive(n, `concurrency[${i}]`)),
    limits,
    shapes: pick(raw.shapes, SHAPES, 'shapes'),
    readModes: pick(raw.readModes, READ_MODES, 'readModes'),

    run: {
      durationSec: Number(run.durationSec),
      warmupSec: Number(run.warmupSec),
      repeats: positive(Number(run.repeats), 'run.repeats'),
    },

    dataset: {
      users: positive(parseSize(ds.users, 'dataset.users'), 'dataset.users'),
      posts: positive(parseSize(ds.posts, 'dataset.posts'), 'dataset.posts'),
      likes: positive(parseSize(ds.likes, 'dataset.likes'), 'dataset.likes'),
      documents: positive(parseSize(ds.documents, 'dataset.documents'), 'dataset.documents'),
      seed: Number(ds.seed),
      tablePrefix: String(ds.tablePrefix),
      loadChunk: positive(parseSize(ds.loadChunk, 'dataset.loadChunk'), 'dataset.loadChunk'),
    },

    guards: {
      maxInFlightRows: positive(parseSize(o(raw.guards, 'guards').maxInFlightRows, 'guards.maxInFlightRows'), 'guards.maxInFlightRows'),
    },

    writes: {
      w1: { rowsPerCell: positive(parseSize(o(w.w1, 'writes.w1').rowsPerCell, 'writes.w1.rowsPerCell'), 'writes.w1.rowsPerCell') },
      w2: {
        rowsPerCell: positive(parseSize(o(w.w2, 'writes.w2').rowsPerCell, 'writes.w2.rowsPerCell'), 'writes.w2.rowsPerCell'),
        duplicateRatio: ratio(o(w.w2, 'writes.w2').duplicateRatio, 'writes.w2.duplicateRatio'),
        seedRows: positive(parseSize(o(w.w2, 'writes.w2').seedRows, 'writes.w2.seedRows'), 'writes.w2.seedRows'),
      },
      w3: {
        batchSizes: sizeList(o(w.w3, 'writes.w3').batchSizes, 'writes.w3.batchSizes'),
        maxRowsPerCell: positive(parseSize(o(w.w3, 'writes.w3').maxRowsPerCell, 'writes.w3.maxRowsPerCell'), 'writes.w3.maxRowsPerCell'),
      },
      w4: { rowsPerCell: positive(parseSize(o(w.w4, 'writes.w4').rowsPerCell, 'writes.w4.rowsPerCell'), 'writes.w4.rowsPerCell') },
    },

    reads: {
      r3: { scoreCutoff: positive(parseSize(o(r.r3, 'reads.r3').scoreCutoff, 'reads.r3.scoreCutoff'), 'reads.r3.scoreCutoff') },
      r4: { maxPages: positive(parseSize(o(r.r4, 'reads.r4').maxPages, 'reads.r4.maxPages'), 'reads.r4.maxPages') },
      r5: {
        multiGetSizes: sizeList(r5.multiGetSizes, 'reads.r5.multiGetSizes'),
        hotKey: {
          enabled: Boolean(hot.enabled),
          hotKeys: ratio(hot.hotKeys, 'reads.r5.hotKey.hotKeys'),
          hotTraffic: ratio(hot.hotTraffic, 'reads.r5.hotKey.hotTraffic'),
        },
      },
      r7: { countRangeFraction: ratio(o(r.r7, 'reads.r7').countRangeFraction, 'reads.r7.countRangeFraction') },
      r8: { fullSortRowCap: positive(parseSize(o(r.r8, 'reads.r8').fullSortRowCap, 'reads.r8.fullSortRowCap'), 'reads.r8.fullSortRowCap') },
      r9: { fullText: Boolean(o(r.r9, 'reads.r9').fullText) },
      r10: {
        docShape: {
          topLevelFields: Number(doc.topLevelFields),
          nestedDepth: positive(Number(doc.nestedDepth), 'reads.r10.docShape.nestedDepth'),
          arraySize: positive(Number(doc.arraySize), 'reads.r10.docShape.arraySize'),
        },
      },
    },

    reports: {
      r4Chart: {
        concurrency: positive(Number(chart.concurrency), 'reports.r4Chart.concurrency'),
        pageSize: positive(parseSize(chart.pageSize, 'reports.r4Chart.pageSize'), 'reports.r4Chart.pageSize'),
      },
      summaryConcurrency: positive(Number(rep.summaryConcurrency), 'reports.summaryConcurrency'),
    },
  };

  validate(cfg);
  return cfg;
}

function validate(cfg: SuiteConfig): void {
  const maxLimit = Math.max(...cfg.limits);
  const planted = new Set(cfg.limits).size === 0 ? 0 : [...new Set(cfg.limits)].reduce((a, b) => a + b, 0);

  if (cfg.dataset.users < maxLimit) {
    throw new Error(`config: dataset.users (${cfg.dataset.users}) must be at least the largest limit (${maxLimit})`);
  }
  // R3/R6/R9 plant one block of matching rows per limit, so the users table has to hold them all.
  if (cfg.dataset.users < planted) {
    throw new Error(
      `config: dataset.users (${cfg.dataset.users}) must be at least the sum of the limits (${planted}), ` +
        'because text-search and JSON tests plant one block of matching rows per limit',
    );
  }
  if (cfg.dataset.documents < planted) {
    throw new Error(
      `config: dataset.documents (${cfg.dataset.documents}) must be at least the sum of the limits (${planted})`,
    );
  }
  if (cfg.run.durationSec <= 0 || cfg.run.warmupSec < 0) {
    throw new Error('config: run.durationSec must be > 0 and run.warmupSec >= 0');
  }
}

export interface LoadOptions {
  /** Path given explicitly with --config. A missing explicit file is an error. */
  path?: string | undefined;
  profile?: string | undefined;
}

export async function loadConfig(opts: LoadOptions = {}): Promise<SuiteConfig> {
  let merged: Obj = DEFAULTS;

  const target = opts.path ?? DEFAULT_CONFIG_PATH;
  try {
    const text = await readFile(target, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isObj(parsed)) throw new Error(`${target} must contain a JSON object`);
    merged = deepMerge(merged, parsed);
  } catch (err) {
    const missing = (err as { code?: string }).code === 'ENOENT';
    if (!missing || opts.path) {
      throw new Error(`could not load config ${target}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const profiles = isObj(merged.profiles) ? merged.profiles : {};
  if (opts.profile) {
    const overlay = profiles[opts.profile];
    if (!isObj(overlay)) {
      throw new Error(`unknown profile "${opts.profile}"; available: ${Object.keys(profiles).join(', ')}`);
    }
    merged = deepMerge(merged, overlay);
  }

  return resolveConfig(merged);
}
