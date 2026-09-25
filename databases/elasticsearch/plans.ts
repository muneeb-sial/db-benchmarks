/**
 * Elasticsearch query planning: specs become a search / count / aggregation request.
 * Shared by the per-test impl (impl.ts) and the suite's explain (suite.ts).
 */

import { Client, type estypes } from '@elastic/elasticsearch';
import { nestedPath } from '../../src/suite/data.ts';
import type { DocShape, SuiteConfig } from '../../src/types/config.type.ts';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { AggSpec, JsonSpec, QueryKind, ReadSpec, RunOut, TextSpec } from '../../src/types/specs.type.ts';

const noRows: RunOut = { rows: 0, lastKey: null };

/** `index.max_result_window`: must cover the largest `from + size` any test asks for. */
export const maxResultWindowFor = (c: SuiteConfig): number =>
  Math.max(10_000, ...c.limits, c.reads.r8.fullSortRowCap) + 1;

export const isDocTable = (t: SuiteTable): boolean => t === 'documents' || t === 'w_docs';

export const toSource = (table: SuiteTable, row: SuiteRow): Record<string, unknown> =>
  isDocTable(table) ? { id: row.id, ...(row.doc as Record<string, unknown>) } : { ...row };

export const idFor = (table: SuiteTable, row: SuiteRow): string =>
  table === 'w_uk' ? String(row.email) : String(row.id);

export function createPlans(
  getClient: () => Client,
  index: (table: SuiteTable) => string,
  docShape: () => DocShape,
  maxResultWindow: () => number,
) {
  const idOfHit = (hit: { _id?: string; _source?: unknown }): number | null => {
    const src = hit._source as Record<string, unknown> | undefined;
    const v = src?.id;
    return typeof v === 'number' ? v : null;
  };


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
      size: spec.limit ?? maxResultWindow(),
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

  const exec = async (q: QueryKind): Promise<RunOut> => {
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
  };

  return { plan, aggBody, exec };
}
