/**
 * Elasticsearch implementation of the benchmark suite.
 *
 * Elasticsearch is a document store with no relational joins, so shapes
 * beyond `simple` are honestly N/A -- same limitation Cassandra reports, for
 * the same reason. Everything else the suite asks for maps onto what
 * Elasticsearch actually does well:
 *
 *   - text search (R9) is the point of the engine: prefix/contains/suffix
 *     become `wildcard` queries on a `keyword` field, fulltext becomes a
 *     `match` query on an analyzed `text` field
 *   - JSON documents (W4/R10) are native; `tag`/nested-path/`tags` filters
 *     are exact-match `term` queries against the keyword sub-field Elasticsearch's
 *     default dynamic mapping creates automatically
 *   - `posts-per-user`, `likes-per-post`, `likes-per-user` need no join at
 *     all: `posts`/`likes` already carry the foreign key directly, so these
 *     are plain `terms` aggregations
 *   - offset paging works, but only because `index.max_result_window` is
 *     raised at schema-creation time to cover the largest configured limit
 *     (Elasticsearch caps `from + size` at 10,000 by default)
 *
 * There is no runtime way to toggle indexing for one field without a full
 * reindex, so `createIndex`/`dropIndex` throw, matching the precedent
 * `databases/cassandra/suite.ts` sets for a different reason (SAI indexes
 * there are schema, not a runtime toggle).
 */

import { Client, errors, type estypes } from '@elastic/elasticsearch';
import { nestedPath } from '../../src/suite/data.ts';
import { ALL_TABLES } from '../../src/suite/schema.ts';
import { OK, na } from '../../src/suite/specs.ts';
import type { DocShape, SuiteConfig } from '../../src/types/config.type.ts';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { AggSpec, ExplainOut, Feature, IndexKind, JsonSpec, QueryKind, ReadSpec, RunOut, SuiteAdapter, Support, TextSpec } from '../../src/types/specs.type.ts';

const UNIQUE_STATUS = 409;
const noRows: RunOut = { rows: 0, lastKey: null };

class UniqueViolation extends Error {}

function isConflict(err: unknown): boolean {
  return err instanceof errors.ResponseError && err.meta.statusCode === UNIQUE_STATUS;
}

export function createElasticsearchSuite(getClient: () => Client): SuiteAdapter {
  let cfg: SuiteConfig | null = null;
  let maxResultWindow = 10_000;

  const config = (): SuiteConfig => {
    if (!cfg) throw new Error('elasticsearch suite used before resetSchema()');
    return cfg;
  };
  const index = (table: SuiteTable): string => `${config().dataset.tablePrefix}${table}`;
  const docShape = (): DocShape => config().reads.r10.docShape;

  const isDocTable = (t: SuiteTable): boolean => t === 'documents' || t === 'w_docs';

  const idOfHit = (hit: { _id?: string; _source?: unknown }): number | null => {
    const src = hit._source as Record<string, unknown> | undefined;
    const v = src?.id;
    return typeof v === 'number' ? v : null;
  };

  const toSource = (table: SuiteTable, row: SuiteRow): Record<string, unknown> =>
    isDocTable(table) ? { id: row.id, ...(row.doc as Record<string, unknown>) } : { ...row };

  const idFor = (table: SuiteTable, row: SuiteRow): string =>
    table === 'w_uk' ? String(row.email) : String(row.id);

  // ---------------------------------------------------------------- reads --

  interface Plan {
    index: SuiteTable;
    query: Record<string, unknown>;
    sort: Record<string, 'asc' | 'desc'>[];
    from: number;
    size: number;
  }

  function readFilters(spec: ReadSpec): Record<string, unknown>[] {
    const clauses: Record<string, unknown>[] = [];
    const f = spec.filter;
    switch (f.kind) {
      case 'none':
        break;
      case 'email':
        clauses.push({ term: { email: f.value } });
        break;
      case 'scoreBelow':
        clauses.push({ range: { score: { lt: f.value } } });
        break;
      case 'range':
        clauses.push({ range: { created_at: { gte: f.from.toISOString(), lte: f.to.toISOString() } } });
        break;
      case 'id':
        clauses.push({ term: { id: f.value } });
        break;
      case 'ids':
        clauses.push({ terms: { id: f.values } });
        break;
      case 'idCap':
        clauses.push({ range: { id: { lte: f.cap } } });
        break;
    }
    // Cursor mode pages the same way every non-join adapter does: filter on
    // id past the last key, sorted by id, instead of a real search_after.
    if (spec.mode === 'cursor') clauses.push({ range: { id: { gt: spec.after } } });
    return clauses;
  }

  function readPlan(spec: ReadSpec): Plan {
    const clauses = readFilters(spec);
    const sort: Plan['sort'] = spec.sort
      ? [{ [spec.sort.column]: 'asc' }, { id: 'asc' }]
      : [{ id: 'asc' }];
    return {
      index: 'users',
      query: clauses.length > 0 ? { bool: { filter: clauses } } : { match_all: {} },
      sort,
      from: spec.mode === 'offset' ? spec.offset : 0,
      size: spec.limit ?? maxResultWindow,
    };
  }

  function aggPlan(spec: AggSpec): Plan {
    switch (spec.kind) {
      case 'count-all':
        return { index: 'users', query: { match_all: {} }, sort: [], from: 0, size: 0 };
      case 'count-indexed':
        return {
          index: 'users',
          query: {
            range: {
              created_at: { gte: spec.range!.from.toISOString(), lte: spec.range!.to.toISOString() },
            },
          },
          sort: [],
          from: 0,
          size: 0,
        };
      case 'count-nonindexed':
        return {
          index: 'users',
          query: { range: { score: { lt: spec.scoreBelow! } } },
          sort: [],
          from: 0,
          size: 0,
        };
      case 'sum':
        return { index: 'posts', query: { match_all: {} }, sort: [], from: 0, size: 0 };
      case 'posts-per-user':
        return { index: 'posts', query: { match_all: {} }, sort: [], from: 0, size: 0 };
      case 'likes-per-post':
        return { index: 'likes', query: { match_all: {} }, sort: [], from: 0, size: 0 };
      case 'likes-per-user':
        return { index: 'likes', query: { match_all: {} }, sort: [], from: 0, size: 0 };
    }
  }

  function aggBody(spec: AggSpec): Record<string, estypes.AggregationsAggregationContainer> | undefined {
    switch (spec.kind) {
      case 'sum':
        return { total: { sum: { field: 'views' } } };
      case 'posts-per-user':
        return { g: { terms: { field: 'user_id', size: 10 } } };
      case 'likes-per-post':
        return { g: { terms: { field: 'post_id', size: 10 } } };
      case 'likes-per-user':
        return { g: { terms: { field: 'user_id', size: 10 } } };
      default:
        return undefined;
    }
  }

  function textPlan(spec: TextSpec): Plan {
    const query: Record<string, unknown> =
      spec.pattern === 'fulltext'
        ? { match: { bio: `zq${spec.limit}` } }
        : {
            wildcard: {
              name: {
                value:
                  spec.pattern === 'prefix'
                    ? `pfx${spec.limit}-*`
                    : spec.pattern === 'contains'
                      ? `*-mid${spec.limit}-*`
                      : `*-sfx${spec.limit}`,
                case_insensitive: true,
              },
            },
          };
    return { index: 'users', query, sort: [{ id: 'asc' }], from: 0, size: spec.limit };
  }

  function jsonPlan(spec: JsonSpec): Plan {
    const marker = `k${spec.limit}`;
    const field =
      spec.filter === 'top'
        ? 'tag.keyword'
        : spec.filter === 'nested'
          ? `${nestedPath(docShape()).join('.')}.keyword`
          : 'tags.keyword';
    return {
      index: 'documents',
      query: { term: { [field]: marker } },
      sort: [{ id: 'asc' }],
      from: 0,
      size: spec.limit,
    };
  }

  function plan(q: QueryKind): Plan {
    switch (q.kind) {
      case 'read':
        return readPlan(q.spec);
      case 'agg':
        return aggPlan(q.spec);
      case 'text':
        return textPlan(q.spec);
      case 'json':
        return jsonPlan(q.spec);
    }
  }

  // --------------------------------------------------------------- adapter --

  return {
    support(f: Feature): Support {
      switch (f.kind) {
        case 'write':
          return OK;
        case 'json':
          // Every field is indexed from the moment it is mapped; there is no
          // separate "unindexed" state to toggle at runtime; see createIndex.
          return f.spec.indexed
            ? na('every Elasticsearch field is indexed by default; there is no runtime index toggle')
            : OK;
        case 'text':
          return f.spec.indexed
            ? na('every Elasticsearch field is indexed by default; there is no runtime index toggle')
            : OK;
        case 'agg':
          return OK;
        case 'read': {
          const s = f.spec;
          if (s.shape !== 'simple') return na('Elasticsearch has no relational joins');
          return OK;
        }
      }
    },

    async resetSchema(c) {
      cfg = c;
      maxResultWindow = Math.max(10_000, ...c.limits, c.reads.r8.fullSortRowCap) + 1;

      for (const t of ALL_TABLES) {
        await getClient().indices.delete({ index: index(t), ignore_unavailable: true });
      }

      const userLike = {
        id: { type: 'integer' as const },
        email: { type: 'keyword' as const },
        name: { type: 'keyword' as const },
        score: { type: 'integer' as const },
        created_at: { type: 'date' as const },
        bio: { type: 'text' as const },
      };
      const settings = { index: { max_result_window: maxResultWindow } };

      await getClient().indices.create({
        index: index('users'),
        settings,
        mappings: { properties: userLike },
      });
      await getClient().indices.create({
        index: index('w_plain'),
        settings,
        mappings: { properties: userLike },
      });
      await getClient().indices.create({
        index: index('w_uk'),
        settings,
        mappings: { properties: userLike },
      });
      await getClient().indices.create({
        index: index('posts'),
        settings,
        mappings: {
          properties: {
            id: { type: 'integer' },
            user_id: { type: 'integer' },
            title: { type: 'text' },
            views: { type: 'integer' },
            created_at: { type: 'date' },
          },
        },
      });
      await getClient().indices.create({
        index: index('likes'),
        settings,
        mappings: {
          properties: {
            id: { type: 'integer' },
            post_id: { type: 'integer' },
            user_id: { type: 'integer' },
            created_at: { type: 'date' },
          },
        },
      });
      // documents/w_docs stay dynamically mapped: the whole point is that the
      // shape (nesting depth, array size, field count) is config-driven.
      await getClient().indices.create({ index: index('documents'), settings });
      await getClient().indices.create({ index: index('w_docs'), settings });
    },

    async afterLoad() {
      // Elasticsearch is near-real-time: a bulk-loaded document is not
      // guaranteed searchable until the next refresh. Force one now so the
      // read tests that follow see the full dataset, the same guarantee every
      // other engine gives for free.
      await getClient().indices.refresh({ index: ALL_TABLES.map(index).join(',') });
    },

    async bulkInsert(t, rows) {
      if (rows.length === 0) return;
      const operations = rows.flatMap((r) => [
        { index: { _index: index(t), _id: idFor(t, r) } },
        toSource(t, r),
      ]);
      await getClient().bulk({ operations, refresh: false });
    },

    async insertOne(t, row) {
      try {
        await getClient().index({
          index: index(t),
          id: idFor(t, row),
          document: toSource(t, row),
          op_type: 'create',
        });
      } catch (err) {
        if (isConflict(err)) throw new UniqueViolation('duplicate email');
        throw err;
      }
    },

    isUniqueViolation: (err) => err instanceof UniqueViolation,

    async truncate(t) {
      await getClient().deleteByQuery({ index: index(t), query: { match_all: {} }, refresh: true });
    },

    async run(q): Promise<RunOut> {
      const p = plan(q);
      if (q.kind === 'agg') {
        const body = aggBody(q.spec);
        if (!body) {
          const res = await getClient().count({ index: index(p.index), query: p.query });
          return { rows: res.count > 0 ? 1 : 0, lastKey: null };
        }
        const res = await getClient().search({ index: index(p.index), size: 0, query: p.query, aggs: body });
        return { rows: Object.keys(res.aggregations ?? {}).length > 0 ? 1 : 0, lastKey: null };
      }
      const res = await getClient().search({
        index: index(p.index),
        query: p.query,
        sort: p.sort,
        from: p.from,
        size: p.size,
      });
      const hits = res.hits.hits;
      if (hits.length === 0) return noRows;
      return { rows: hits.length, lastKey: idOfHit(hits[hits.length - 1]!) };
    },

    async explain(q): Promise<ExplainOut> {
      const p = plan(q);
      if (q.kind === 'agg') {
        return { text: `aggregation on ${index(p.index)}: ${JSON.stringify(aggBody(q.spec) ?? p.query)}`, indexUsed: null };
      }
      const res = await getClient().indices.validateQuery({
        index: index(p.index),
        query: p.query,
        explain: true,
      });
      const text = (res.explanations ?? []).map((e) => e.explanation).join('\n') || JSON.stringify(p.query);
      // Every field in Elasticsearch is served from its own inverted/doc-values
      // index; there is no scan-vs-index-scan distinction the way SQL has one.
      return { text: text.slice(0, 8000), indexUsed: null };
    },

    async createIndex(): Promise<void> {
      throw new Error(
        'elasticsearch suite has no runtime index toggle: every mapped field is indexed from creation, ' +
          'and disabling one requires a full reindex',
      );
    },
    async dropIndex(): Promise<void> {
      throw new Error(
        'elasticsearch suite has no runtime index toggle: every mapped field is indexed from creation, ' +
          'and disabling one requires a full reindex',
      );
    },
    async indexSizeBytes(_kind: IndexKind): Promise<number | null> {
      return null;
    },
  };
}
