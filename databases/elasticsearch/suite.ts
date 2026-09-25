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

import type { Client } from '@elastic/elasticsearch';
import { createPlans, maxResultWindowFor } from './plans.ts';
import { UniqueViolation } from './impl.ts';
import { ALL_TABLES } from '../../src/suite/schema.ts';
import { OK, na } from '../../src/suite/specs.ts';
import type { DocShape, SuiteConfig } from '../../src/types/config.type.ts';
import type { SuiteTable } from '../../src/types/schema.type.ts';
import type { ExplainOut, Feature, IndexKind, RunOut, SuiteAdapter, Support } from '../../src/types/specs.type.ts';

const PROVIDED = 'reads and writes are provided by createElasticsearchImpl via withImpl';

export function createElasticsearchSuite(getClient: () => Client): SuiteAdapter {
  let cfg: SuiteConfig | null = null;
  let maxResultWindow = 10_000;

  const config = (): SuiteConfig => {
    if (!cfg) throw new Error('elasticsearch suite used before resetSchema()');
    return cfg;
  };
  const index = (table: SuiteTable): string => `${config().dataset.tablePrefix}${table}`;
  const docShape = (): DocShape => config().reads.r10.docShape;
  const plans = createPlans(getClient, index, docShape, () => maxResultWindow);

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
      maxResultWindow = maxResultWindowFor(c);

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

    bulkInsert: () => Promise.reject(new Error(PROVIDED)),
    insertOne: () => Promise.reject(new Error(PROVIDED)),

    isUniqueViolation: (err) => err instanceof UniqueViolation,

    async truncate(t) {
      await getClient().deleteByQuery({ index: index(t), query: { match_all: {} }, refresh: true });
    },

    run: (): Promise<RunOut> => Promise.reject(new Error(PROVIDED)),

    async explain(q): Promise<ExplainOut> {
      const p = plans.plan(q);
      if (q.kind === 'agg') {
        return { text: `aggregation on ${index(p.index)}: ${JSON.stringify(plans.aggBody(q.spec) ?? p.query)}`, indexUsed: null };
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
