/**
 * The contract every database implements, as one class per engine.
 *
 * There is deliberately no shared query text anywhere: each engine class
 * writes its own SQL / CQL / pipeline / DSL for every operation, shape and
 * mode. Postgres and MySQL do not share a single statement. What the base
 * class provides is lifecycle state and N/A plumbing, never queries.
 *
 * Methods return a row count (and the last key, for cursor walks), not the
 * rows: rows are fully fetched from the driver but not serialized over HTTP,
 * so JSON encoding never dominates the measured latency.
 */

import { NotSupported } from '../http/errors.ts';
import type {
  CellParams,
  IndexKind,
  JsonVariant,
  LikePattern,
  OpId,
  OpResult,
  R7Variant,
  ReadQuery,
  Row,
  ScratchTable,
  SeedTable,
  Shape,
  SortKey,
} from './types.ts';

/** Extra values R7 needs: the unindexed cutoff and the indexed created_at range. */
export interface R7Args {
  cutoff: number;
  from: Date;
  to: Date;
}

export interface LikeOutcome extends OpResult {
  /** The (user, post) pair already existed; the transaction rolled back. */
  conflict: boolean;
  retries: number;
}

export interface LikeCheck {
  checked: number;
  mismatches: number;
}

export abstract class Engine {
  /** Route name, e.g. `postgres`. */
  abstract readonly name: string;
  abstract readonly displayName: string;

  /**
   * Path to the nested R10 field, e.g. ['l1', 'l2', 'value']. Set by the
   * router from the seed manifest before resetSchema().
   */
  docPath: string[] = ['l1', 'l2', 'value'];

  /**
   * Why `op` with these params cannot run on this engine, or null if it can.
   * The router calls this before every op, and GET /:db/coverage lists it for
   * the whole matrix, so N/A reasons are visible without running anything.
   */
  abstract support(op: OpId, p: CellParams): string | null;

  // ------------------------------------------------------------ lifecycle --
  abstract connect(): Promise<void>;
  abstract close(): Promise<void>;
  /** Drop and recreate every table (seed + scratch). */
  abstract resetSchema(): Promise<void>;
  abstract seedChunk(table: SeedTable, rows: Row[]): Promise<void>;
  /** Baseline secondary indexes and statistics, once the seed is loaded. */
  abstract afterLoad(): Promise<void>;
  abstract createIndex(kind: IndexKind): Promise<void>;
  abstract dropIndex(kind: IndexKind): Promise<void>;
  /**
   * Kinds that share one physical index with `kind`, itself included. Building
   * or dropping one builds or drops them all (CockroachDB serves every JSON
   * kind from one inverted index on `doc`).
   */
  sharedIndexes(kind: IndexKind): IndexKind[] {
    return [kind];
  }
  abstract truncateScratch(table: ScratchTable): Promise<void>;
  /** Server version and memory settings, recorded with every run. */
  abstract describe(): Promise<Record<string, string>>;

  // ---------------------------------------------------------------- reads --
  /** R1: no filter, paged per mode. */
  abstract r1Scan(q: ReadQuery): Promise<OpResult>;
  /** R2: lookup on the unique key `email`. */
  abstract r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult>;
  /** R3: `score < cutoff`, a column with no index. */
  abstract r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult>;
  /** R4: one page of a whole-table walk. Same query as R1 by definition. */
  r4Page(q: ReadQuery): Promise<OpResult> {
    return this.r1Scan(q);
  }
  /** R5: point lookup by primary key. */
  abstract r5GetById(shape: Shape, id: number): Promise<OpResult>;
  /** R5: multi-get, `id IN (...)`. */
  abstract r5MultiGet(ids: number[]): Promise<OpResult>;
  /** R6: `created_at BETWEEN from AND to`, paged per mode. */
  abstract r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult>;
  /** R7: one of seven aggregates. Returns the number of result rows (1 for scalars). */
  abstract r7Aggregate(variant: R7Variant, args: R7Args): Promise<OpResult>;
  /** R8: top-N ordered by an indexed (created_at) or unindexed (score) key. */
  abstract r8TopN(shape: Shape, key: SortKey, limit: number): Promise<OpResult>;
  /** R8: full sort on score with no limit, over users with id <= cap. */
  abstract r8FullSort(cap: number): Promise<OpResult>;
  /** R9: LIKE / regex on users.name. `term` is the bare marker, not a pattern. */
  abstract r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult>;
  /** R9: full-text match on users.bio. */
  abstract r9FullText(term: string, limit: number): Promise<OpResult>;
  /** R10: JSON filter on documents. */
  abstract r10Json(variant: JsonVariant, value: string, limit: number): Promise<OpResult>;

  // --------------------------------------------------------------- writes --
  /** W1: single insert into w_plain (no unique key). */
  abstract w1Insert(row: Row): Promise<OpResult>;
  /** W2: single insert into w_uk. Throws UniqueViolation on a duplicate email. */
  abstract w2InsertUnique(row: Row): Promise<OpResult>;
  /** W3: one batch into w_plain. */
  abstract w3InsertBatch(rows: Row[]): Promise<OpResult>;
  /** W4: one JSON document into w_docs. */
  abstract w4InsertDoc(row: Row): Promise<OpResult>;

  // ---------------------------------------------------------- transaction --
  /** Atomically: posts.like_count += 1, insert into likes. Posts first, always. */
  abstract likeTx(postId: number, userId: number): Promise<LikeOutcome>;
  /** posts.like_count must equal the actual count of likes per post. */
  abstract verifyLikeCounts(): Promise<LikeCheck>;

  // -------------------------------------------------------------- helpers --
  notSupported(what: string, reason: string): NotSupported {
    return new NotSupported(this.name, what, reason);
  }
}
