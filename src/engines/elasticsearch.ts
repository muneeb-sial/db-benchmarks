/**
 * Elasticsearch 8, spoken to over its REST API with fetch (Bun keeps the
 * connections alive), so each query below is the literal Query DSL body.
 *
 * What it is and is not:
 *   - no joins: every non-simple shape is N/A, as are the join aggregates
 *   - offset is from/size, which stops at index.max_result_window (10,000);
 *     deeper offset pages are N/A rather than silently switched to scroll
 *   - cursor is search_after on id, the idiomatic keyset page
 *   - `score` is mapped index:false + doc_values, the closest equivalent to
 *     "not indexed": range queries on it run off doc values, no inverted index
 *   - every field is indexed at mapping time, so the R9/R10 "build an index"
 *     cells are N/A; their queries run against the mapping
 *   - no transactions, so the like transaction is N/A
 *   - W2 uniqueness is `_create` with _id = email, which returns 409 on a repeat
 *
 * Writes use refresh=false (the default); afterLoad forces one refresh so
 * reads see the whole seed.
 */

import { CONNECTIONS } from '../config/config.ts';
import { Engine, type LikeCheck, type LikeOutcome, type R7Args } from '../engine/engine.ts';
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
} from '../engine/types.ts';
import { UniqueViolation } from '../http/errors.ts';

const MAX_WINDOW = 10_000;
const NO_JOINS = 'Elasticsearch has no joins';
const NO_INDEX = 'Elasticsearch indexes every field at mapping time; there is no separate index to build';
const NO_TX = 'Elasticsearch has no transactions';
const NO_DEEP_OFFSET = `offset paging stops at index.max_result_window (${MAX_WINDOW.toLocaleString('en-US')})`;

interface Hit {
  _id: string;
  _source?: Record<string, unknown>;
  sort?: unknown[];
}
interface SearchResponse {
  hits: { hits: Hit[] };
  aggregations?: Record<string, unknown>;
}

class EsError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`elasticsearch ${status}: ${JSON.stringify(body).slice(0, 500)}`);
  }
}

const USER_PROPS = {
  id: { type: 'integer' },
  email: { type: 'keyword' },
  name: { type: 'keyword' },
  score: { type: 'integer', index: false, doc_values: true },
  created_at: { type: 'date' },
  bio: { type: 'text' },
};

/** Documents keep their own fields at the top level; every string is a keyword. */
const DOC_MAPPING = {
  dynamic_templates: [{ strings: { match_mapping_type: 'string', mapping: { type: 'keyword' } } }],
  properties: { id: { type: 'integer' } },
};

const SETTINGS = { number_of_shards: 1, number_of_replicas: 0 };

function page(r: SearchResponse): OpResult {
  const hits = r.hits.hits;
  const last = hits.length ? Number(hits[hits.length - 1]!._source?.id ?? hits[hits.length - 1]!._id) : null;
  return { rows: hits.length, last };
}

export class ElasticEngine extends Engine {
  readonly name = 'elasticsearch';
  readonly displayName = 'Elasticsearch';
  private readonly url = CONNECTIONS.elasticsearch.url.replace(/\/$/, '');

  private async es<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.url}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json().catch(() => ({}))) as T;
    if (!res.ok) throw new EsError(res.status, json);
    return json;
  }

  private async bulk(lines: unknown[]): Promise<void> {
    const res = await fetch(`${this.url}/_bulk`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-ndjson' },
      body: lines.map((l) => JSON.stringify(l)).join('\n') + '\n',
    });
    const json = (await res.json()) as { errors?: boolean; items?: unknown[] };
    if (!res.ok || json.errors) throw new EsError(res.status, json.items?.find((i) => JSON.stringify(i).includes('"error"')) ?? json);
  }

  private search(index: string, body: Record<string, unknown>): Promise<SearchResponse> {
    return this.es<SearchResponse>('POST', `/${index}/_search`, { track_total_hits: false, ...body });
  }

  support(op: OpId, p: CellParams): string | null {
    switch (op) {
      case 'r1':
      case 'r2':
      case 'r3':
      case 'r4':
      case 'r6':
      case 'r5-id':
      case 'r8-topn':
        return p.shape && p.shape !== 'simple' ? NO_JOINS : null;
      case 'r7':
        return ['count-all', 'count-indexed', 'count-unindexed', 'sum-views'].includes(p.variant ?? '') ? null : NO_JOINS;
      case 'index':
        return NO_INDEX;
      case 'like':
        return NO_TX;
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ lifecycle --

  async connect(): Promise<void> {
    await this.es('GET', '/_cluster/health?wait_for_status=yellow&timeout=30s');
  }

  async close(): Promise<void> {}

  async describe(): Promise<Record<string, string>> {
    const info = await this.es<{ version: { number: string } }>('GET', '/');
    const nodes = await this.es<{ nodes: Record<string, { jvm?: { mem?: { heap_max_in_bytes?: number } } }> }>(
      'GET', '/_nodes/jvm');
    const heap = Object.values(nodes.nodes)[0]?.jvm?.mem?.heap_max_in_bytes;
    return { version: info.version.number, heapGB: heap ? (heap / 1024 ** 3).toFixed(2) : 'unknown' };
  }

  private async recreate(index: string, mappings: Record<string, unknown>, settings: Record<string, unknown> = SETTINGS): Promise<void> {
    await this.es('DELETE', `/${index}`).catch((e) => {
      if (!(e instanceof EsError && e.status === 404)) throw e;
    });
    await this.es('PUT', `/${index}`, { settings, mappings });
  }

  async resetSchema(): Promise<void> {
    // Seed indexes load with refresh off; afterLoad turns it back on.
    const loading = { ...SETTINGS, refresh_interval: '-1' };
    await this.recreate('srv_users', { properties: USER_PROPS }, loading);
    await this.recreate('srv_posts', {
      properties: {
        id: { type: 'integer' }, user_id: { type: 'integer' }, title: { type: 'text' },
        views: { type: 'integer' }, like_count: { type: 'integer' }, created_at: { type: 'date' },
      },
    }, loading);
    await this.recreate('srv_documents', DOC_MAPPING, loading);
    await this.recreate('srv_w_plain', { properties: USER_PROPS });
    await this.recreate('srv_w_uk', { properties: USER_PROPS });
    await this.recreate('srv_w_docs', DOC_MAPPING);
  }

  async seedChunk(table: SeedTable, rows: Row[]): Promise<void> {
    switch (table) {
      case 'users':
        return this.bulk(rows.flatMap((r) => [{ index: { _index: 'srv_users', _id: String(r.id) } }, r]));
      case 'posts':
        return this.bulk(rows.flatMap((r) => [{ index: { _index: 'srv_posts', _id: String(r.id) } }, r]));
      case 'likes':
        return; // backs only joins, which are N/A here
      case 'documents':
        return this.bulk(rows.flatMap((r) => [
          { index: { _index: 'srv_documents', _id: String(r.id) } },
          { id: r.id, ...(r.doc as Record<string, unknown>) },
        ]));
    }
  }

  async afterLoad(): Promise<void> {
    for (const index of ['srv_users', 'srv_posts', 'srv_documents']) {
      await this.es('PUT', `/${index}/_settings`, { index: { refresh_interval: '1s' } });
      await this.es('POST', `/${index}/_refresh`);
    }
  }

  async createIndex(kind: IndexKind): Promise<void> {
    throw this.notSupported(`index ${kind}`, NO_INDEX);
  }

  async dropIndex(_kind: IndexKind): Promise<void> {}

  async truncateScratch(table: ScratchTable): Promise<void> {
    switch (table) {
      case 'w_plain':
        return this.recreate('srv_w_plain', { properties: USER_PROPS });
      case 'w_uk':
        return this.recreate('srv_w_uk', { properties: USER_PROPS });
      case 'w_docs':
        return this.recreate('srv_w_docs', DOC_MAPPING);
      case 'tx_likes':
        return;
    }
  }

  // ---------------------------------------------------------------- reads --

  private checkWindow(what: string, q: ReadQuery): void {
    if (q.mode === 'offset' && q.offset + q.limit > MAX_WINDOW) throw this.notSupported(what, NO_DEEP_OFFSET);
  }

  async r1Scan(q: ReadQuery): Promise<OpResult> {
    if (q.shape !== 'simple') throw this.notSupported('r1', NO_JOINS);
    this.checkWindow('r1', q);
    switch (q.mode) {
      case 'limit':
        return page(await this.search('srv_users', { size: q.limit, sort: [{ id: 'asc' }] }));
      case 'offset':
        return page(await this.search('srv_users', { from: q.offset, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'cursor':
        return page(await this.search('srv_users', { size: q.limit, sort: [{ id: 'asc' }], search_after: [q.after] }));
    }
  }

  async r2FindByEmail(q: ReadQuery, email: string): Promise<OpResult> {
    if (q.shape !== 'simple') throw this.notSupported('r2', NO_JOINS);
    this.checkWindow('r2', q);
    const query = { term: { email } };
    switch (q.mode) {
      case 'limit':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'offset':
        return page(await this.search('srv_users', { query, from: q.offset, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'cursor':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }], search_after: [q.after] }));
    }
  }

  async r3FilterUnindexedScore(q: ReadQuery, cutoff: number): Promise<OpResult> {
    if (q.shape !== 'simple') throw this.notSupported('r3', NO_JOINS);
    this.checkWindow('r3', q);
    // score has no inverted index (index:false); the range runs off doc values.
    const query = { range: { score: { lt: cutoff } } };
    switch (q.mode) {
      case 'limit':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'offset':
        return page(await this.search('srv_users', { query, from: q.offset, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'cursor':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }], search_after: [q.after] }));
    }
  }

  async r5GetById(shape: Shape, id: number): Promise<OpResult> {
    if (shape !== 'simple') throw this.notSupported('r5-id', NO_JOINS);
    try {
      await this.es('GET', `/srv_users/_doc/${id}`);
      return { rows: 1, last: id };
    } catch (err) {
      if (err instanceof EsError && err.status === 404) return { rows: 0, last: null };
      throw err;
    }
  }

  async r5MultiGet(ids: number[]): Promise<OpResult> {
    const r = await this.es<{ docs: { found: boolean }[] }>('POST', '/srv_users/_mget', { ids: ids.map(String) });
    return { rows: r.docs.filter((d) => d.found).length };
  }

  async r6CreatedAtRange(q: ReadQuery, from: Date, to: Date): Promise<OpResult> {
    if (q.shape !== 'simple') throw this.notSupported('r6', NO_JOINS);
    this.checkWindow('r6', q);
    const query = { range: { created_at: { gte: from.toISOString(), lte: to.toISOString() } } };
    switch (q.mode) {
      case 'limit':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'offset':
        return page(await this.search('srv_users', { query, from: q.offset, size: q.limit, sort: [{ id: 'asc' }] }));
      case 'cursor':
        return page(await this.search('srv_users', { query, size: q.limit, sort: [{ id: 'asc' }], search_after: [q.after] }));
    }
  }

  async r7Aggregate(variant: R7Variant, a: R7Args): Promise<OpResult> {
    switch (variant) {
      case 'count-all':
        await this.es('POST', '/srv_users/_count', { query: { match_all: {} } });
        return { rows: 1 };
      case 'count-indexed':
        await this.es('POST', '/srv_users/_count', {
          query: { range: { created_at: { gte: a.from.toISOString(), lte: a.to.toISOString() } } },
        });
        return { rows: 1 };
      case 'count-unindexed':
        await this.es('POST', '/srv_users/_count', { query: { range: { score: { lt: a.cutoff } } } });
        return { rows: 1 };
      case 'sum-views':
        await this.search('srv_posts', { size: 0, aggs: { total: { sum: { field: 'views' } } } });
        return { rows: 1 };
      default:
        throw this.notSupported('r7', NO_JOINS);
    }
  }

  async r8TopN(shape: Shape, key: SortKey, limit: number): Promise<OpResult> {
    if (shape !== 'simple') throw this.notSupported('r8-topn', NO_JOINS);
    if (limit > MAX_WINDOW) throw this.notSupported('r8-topn', NO_DEEP_OFFSET);
    switch (key) {
      case 'indexed':
        return page(await this.search('srv_users', { size: limit, sort: [{ created_at: 'desc' }, { id: 'asc' }] }));
      case 'unindexed':
        return page(await this.search('srv_users', { size: limit, sort: [{ score: 'desc' }, { id: 'asc' }] }));
    }
  }

  async r8FullSort(cap: number): Promise<OpResult> {
    // No limit: read every matching row, in pages of the max window, keyset on (score, id).
    let rows = 0;
    let after: unknown[] | undefined;
    for (;;) {
      const r = await this.search('srv_users', {
        query: { range: { id: { lte: cap } } },
        size: MAX_WINDOW,
        sort: [{ score: 'asc' }, { id: 'asc' }],
        ...(after ? { search_after: after } : {}),
      });
      const hits = r.hits.hits;
      rows += hits.length;
      if (hits.length < MAX_WINDOW) return { rows };
      after = hits[hits.length - 1]!.sort;
    }
  }

  async r9Like(pattern: LikePattern, term: string, limit: number): Promise<OpResult> {
    switch (pattern) {
      case 'prefix':
        return page(await this.search('srv_users', { query: { prefix: { name: term } }, size: limit }));
      case 'contains':
        return page(await this.search('srv_users', { query: { wildcard: { name: `*${term}*` } }, size: limit }));
      case 'suffix':
        return page(await this.search('srv_users', { query: { wildcard: { name: `*${term}` } }, size: limit }));
    }
  }

  async r9FullText(term: string, limit: number): Promise<OpResult> {
    return page(await this.search('srv_users', { query: { match: { bio: term } }, size: limit }));
  }

  async r10Json(variant: JsonVariant, value: string, limit: number): Promise<OpResult> {
    switch (variant) {
      case 'top-level':
        return page(await this.search('srv_documents', { query: { term: { tag: value } }, size: limit }));
      case 'nested':
        return page(await this.search('srv_documents', { query: { term: { [this.docPath.join('.')]: value } }, size: limit }));
      case 'array-contains':
        return page(await this.search('srv_documents', { query: { term: { tags: value } }, size: limit }));
    }
  }

  // --------------------------------------------------------------- writes --

  async w1Insert(r: Row): Promise<OpResult> {
    await this.es('PUT', `/srv_w_plain/_doc/${r.id}`, r);
    return { rows: 1 };
  }

  async w2InsertUnique(r: Row): Promise<OpResult> {
    try {
      await this.es('PUT', `/srv_w_uk/_create/${encodeURIComponent(String(r.email))}`, r);
      return { rows: 1 };
    } catch (err) {
      if (err instanceof EsError && err.status === 409) throw new UniqueViolation('duplicate email (_create conflict)');
      throw err;
    }
  }

  async w3InsertBatch(rows: Row[]): Promise<OpResult> {
    await this.bulk(rows.flatMap((r) => [{ index: { _index: 'srv_w_plain', _id: String(r.id) } }, r]));
    return { rows: rows.length };
  }

  async w4InsertDoc(r: Row): Promise<OpResult> {
    await this.es('PUT', `/srv_w_docs/_doc/${r.id}`, { id: r.id, ...(r.doc as Record<string, unknown>) });
    return { rows: 1 };
  }

  // ---------------------------------------------------------- transaction --

  async likeTx(_postId: number, _userId: number): Promise<LikeOutcome> {
    throw this.notSupported('like', NO_TX);
  }

  async verifyLikeCounts(): Promise<LikeCheck> {
    throw this.notSupported('verify', NO_TX);
  }
}
