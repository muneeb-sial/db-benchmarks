import type { ReadMode, Shape } from './config.type.ts';
import type { SuiteConfig } from './config.type.ts';
import type { SuiteRow, SuiteTable } from './schema.type.ts';

export type Filter =
  | { kind: 'none' }
  | { kind: 'email'; value: string }
  | { kind: 'scoreBelow'; value: number }
  | { kind: 'range'; from: Date; to: Date }
  | { kind: 'id'; value: number }
  | { kind: 'ids'; values: number[] }
  | { kind: 'idCap'; cap: number };

export interface ReadSpec {
  test: string;
  shape: Shape;
  filter: Filter;
  mode: ReadMode;
  /** null means unbounded (full sort). */
  limit: number | null;
  /** Used in offset mode. */
  offset: number;
  /** Used in cursor mode: return rows whose key is greater than this. */
  after: number;
  /** null means order by the shape's key only. */
  sort: { column: 'created_at' | 'score' } | null;
}

export type AggKind =
  | 'count-all'
  | 'count-indexed'
  | 'count-nonindexed'
  | 'sum'
  | 'posts-per-user'
  | 'likes-per-post'
  | 'likes-per-user';

export interface AggSpec {
  kind: AggKind;
  range?: { from: Date; to: Date };
  scoreBelow?: number;
}

export type TextPattern = 'prefix' | 'contains' | 'suffix' | 'fulltext';

export interface TextSpec {
  pattern: TextPattern;
  limit: number;
  indexed: boolean;
}

export type JsonFilter = 'top' | 'nested' | 'array';

export interface JsonSpec {
  filter: JsonFilter;
  limit: number;
  indexed: boolean;
}

export type QueryKind =
  | { kind: 'read'; spec: ReadSpec }
  | { kind: 'agg'; spec: AggSpec }
  | { kind: 'text'; spec: TextSpec }
  | { kind: 'json'; spec: JsonSpec };

export type WriteTest = 'w1' | 'w2' | 'w3' | 'w4';

export type Feature = QueryKind | { kind: 'write'; test: WriteTest };

export type Support = { ok: true } | { ok: false; reason: string };

export interface RunOut {
  rows: number;
  /** Key of the last row returned, used to chain cursor pages. */
  lastKey: number | null;
}

export interface ExplainOut {
  text: string;
  /** Best-effort: did the plan use an index? null when the engine cannot say. */
  indexUsed: boolean | null;
}

export type IndexKind = 'text-name' | 'text-fulltext' | 'json-top' | 'json-nested' | 'json-array';

export interface SuiteAdapter {
  support(feature: Feature): Support;

  /** Drop and recreate every suite table. Remembers `cfg` (prefix, doc shape). */
  resetSchema(cfg: SuiteConfig, opts: { documents: boolean }): Promise<void>;

  /** Called once after seeding: create the baseline secondary indexes, refresh stats. */
  afterLoad(): Promise<void>;

  bulkInsert(table: SuiteTable, rows: readonly SuiteRow[]): Promise<void>;
  /** One non-transactional insert. Must throw on a unique-key violation. */
  insertOne(table: SuiteTable, row: SuiteRow): Promise<void>;
  isUniqueViolation(err: unknown): boolean;
  truncate(table: SuiteTable): Promise<void>;

  run(query: QueryKind): Promise<RunOut>;
  explain(query: QueryKind): Promise<ExplainOut>;

  createIndex(kind: IndexKind): Promise<void>;
  dropIndex(kind: IndexKind): Promise<void>;
  indexSizeBytes(kind: IndexKind): Promise<number | null>;
}
