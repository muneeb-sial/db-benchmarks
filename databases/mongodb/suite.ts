/**
 * MongoDB implementation of the benchmark suite.
 *
 * Specs become either a find() or an aggregation pipeline. Joins use $lookup,
 * which is Mongo's idiom for them (and costs what it costs; that is the point
 * of the comparison). Documents map `id` to `_id`, and JSON documents are
 * stored as the collection's own fields, so a "JSON filter" is a native query.
 */

import type { Db, Document } from 'mongodb';
import { nestedPath } from '../../src/suite/data.ts';
import { createPlans } from './plans.ts';
import { ALL_TABLES } from '../../src/suite/schema.ts';
import { OK } from '../../src/suite/specs.ts';
import type { DocShape, SuiteConfig } from '../../src/types/config.type.ts';
import type { SuiteTable } from '../../src/types/schema.type.ts';
import type { ExplainOut, Feature, IndexKind, RunOut, SuiteAdapter, Support } from '../../src/types/specs.type.ts';

const DUPLICATE_KEY = 11000;
const PROVIDED = 'reads and writes are provided by createMongoImpl via withImpl';


export function createMongoSuite(getDb: () => Db): SuiteAdapter {
  let cfg: SuiteConfig | null = null;

  const config = (): SuiteConfig => {
    if (!cfg) throw new Error('mongodb suite used before resetSchema()');
    return cfg;
  };
  const phys = (table: SuiteTable): string => `${config().dataset.tablePrefix}${table}`;
  const coll = (table: SuiteTable) => getDb().collection(phys(table));
  const shape = (): DocShape => config().reads.r10.docShape;

  const plans = createPlans(phys, shape, coll);

  // --------------------------------------------------------------- adapter --

  const indexName = (kind: IndexKind): string => `ix_${kind.replace(/-/g, '_')}`;

  const indexTable = (kind: IndexKind): SuiteTable =>
    kind.startsWith('json') ? 'documents' : 'users';

  return {
    support(_f: Feature): Support {
      return OK;
    },

    async resetSchema(c) {
      cfg = c;
      for (const table of ALL_TABLES) await coll(table).drop().catch(() => {});
      // Unique keys are part of the schema, so they exist before the load.
      await coll('users').createIndex({ email: 1 }, { unique: true });
      await coll('w_uk').createIndex({ email: 1 }, { unique: true });
    },

    async afterLoad() {
      await coll('users').createIndex({ created_at: 1 });
      await coll('posts').createIndex({ user_id: 1 });
      await coll('posts').createIndex({ created_at: 1 });
      await coll('likes').createIndex({ post_id: 1 });
      await coll('likes').createIndex({ user_id: 1 });
    },

    bulkInsert: () => Promise.reject(new Error(PROVIDED)),
    insertOne: () => Promise.reject(new Error(PROVIDED)),


    isUniqueViolation(err) {
      return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY;
    },

    async truncate(table) {
      await coll(table).deleteMany({});
    },

    // Reads and writes are supplied per test by impl.ts (see withImpl in the adapter).
    run: (q): Promise<RunOut> => plans.exec(plans.plan(q)),

    async explain(q): Promise<ExplainOut> {
      const p = plans.plan(q);
      const result =
        p.type === 'find'
          ? await plans.findCursor(p).explain('queryPlanner')
          : await coll(p.table).aggregate(p.pipeline, { allowDiskUse: true }).explain('queryPlanner');
      const text = JSON.stringify(result, null, 1);
      return { text: text.slice(0, 8000), indexUsed: /IXSCAN|TEXT_MATCH/.test(text) };
    },

    async createIndex(kind) {
      const name = indexName(kind);
      const spec: Document =
        kind === 'text-name'
          ? { name: 1 }
          : kind === 'text-fulltext'
            ? { bio: 'text' }
            : kind === 'json-top'
              ? { tag: 1 }
              : kind === 'json-nested'
                ? { [nestedPath(shape()).join('.')]: 1 }
                : { tags: 1 }; // multikey on an array
      await coll(indexTable(kind)).createIndex(spec, { name });
    },

    async dropIndex(kind) {
      await coll(indexTable(kind)).dropIndex(indexName(kind));
    },

    async indexSizeBytes(kind) {
      try {
        const stats = await getDb().command({ collStats: phys(indexTable(kind)) });
        const size = (stats.indexSizes as Record<string, number> | undefined)?.[indexName(kind)];
        return typeof size === 'number' ? size : null;
      } catch {
        return null;
      }
    },
  };
}
