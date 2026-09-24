import type { ReadMode as ReadModes, Shape as Shapes } from '../suite/config.ts';

export type Shape = (typeof Shapes)[keyof typeof Shapes];

export type ReadMode = (typeof ReadModes)[keyof typeof ReadModes];

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

export type Obj = Record<string, unknown>;

export interface LoadOptions {
  /** Path given explicitly with --config. A missing explicit file is an error. */
  path?: string | undefined;
  profile?: string | undefined;
}
