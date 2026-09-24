/**
 * MongoDB implementation of the benchmark suite.
 *
 * Specs become either a find() or an aggregation pipeline. Joins use $lookup,
 * which is Mongo's idiom for them (and costs what it costs; that is the point
 * of the comparison). Documents map `id` to `_id`, and JSON documents are
 * stored as the collection's own fields, so a "JSON filter" is a native query.
 */

import type { Db, Document } from 'mongodb';
import {
  fullTextTerm,
  jsonMarker,
  nestedPath,
  regexTerm,
} from '../../src/suite/data.ts';
import { ALL_TABLES } from '../../src/suite/schema.ts';
import { OK } from '../../src/suite/specs.ts';
import type { DocShape, SuiteConfig } from '../../src/types/config.type.ts';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { AggSpec, ExplainOut, Feature, IndexKind, JsonSpec, QueryKind, ReadSpec, RunOut, SuiteAdapter, Support, TextSpec } from '../../src/types/specs.type.ts';
import type { Plan } from '../../src/types/mongodb.type.ts';

const DUPLICATE_KEY = 11000;

const USER_PROJECTION: Document = { email: 1, name: 1, score: 1, created_at: 1 };

export function createMongoSuite(getDb: () => Db): SuiteAdapter {
  let cfg: SuiteConfig | null = null;

  const config = (): SuiteConfig => {
    if (!cfg) throw new Error('mongodb suite used before resetSchema()');
    return cfg;
  };
  const phys = (table: SuiteTable): string => `${config().dataset.tablePrefix}${table}`;
  const coll = (table: SuiteTable) => getDb().collection(phys(table));
  const shape = (): DocShape => config().reads.r10.docShape;

  const toDoc = (table: SuiteTable, row: SuiteRow): Document => {
    if (table === 'documents' || table === 'w_docs') {
      return { _id: row.id, ...(row.doc as Document) };
    }
    const { id, ...rest } = row;
    return { _id: id, ...rest };
  };

  // ---------------------------------------------------------------- reads --

  function readPlan(spec: ReadSpec): Plan {
    // Conditions on user fields, keyed by plain field name.
    const userMatch: Document = {};
    const f = spec.filter;
    switch (f.kind) {
      case 'none':
        break;
      case 'email':
        userMatch.email = f.value;
        break;
      case 'scoreBelow':
        userMatch.score = { $lt: f.value };
        break;
      case 'range':
        userMatch.created_at = { $gte: f.from, $lte: f.to };
        break;
      case 'id':
        userMatch._id = f.value;
        break;
      case 'ids':
        userMatch._id = { $in: f.values };
        break;
      case 'idCap':
        userMatch._id = { $lte: f.cap };
        break;
    }

    const skip = spec.mode === 'offset' ? spec.offset : 0;
    const limit = spec.limit ?? 0; // 0 means unbounded in Mongo

    if (spec.shape === 'simple') {
      const clauses: Document[] = Object.entries(userMatch).map(([k, v]) => ({ [k]: v }));
      if (spec.mode === 'cursor') clauses.push({ _id: { $gt: spec.after } });
      return {
        type: 'find',
        table: 'users',
        filter: clauses.length > 0 ? { $and: clauses } : {},
        sort: spec.sort ? { [spec.sort.column]: 1, _id: 1 } : { _id: 1 },
        skip,
        limit,
        projection: USER_PROJECTION,
      };
    }

    const multi = spec.shape === 'multi-join';
    const selective = f.kind === 'id' || f.kind === 'ids' || f.kind === 'email';
    const users = phys('users');
    const posts = phys('posts');
    const likes = phys('likes');
    const pageStages: Document[] = [];
    if (skip > 0) pageStages.push({ $skip: skip });
    if (limit > 0) pageStages.push({ $limit: limit });

    if (selective) {
      // A selective user filter is cheapest when it drives the join.
      const keyField = multi ? 'l._id' : 'p._id';
      const stages: Document[] = [
        { $match: userMatch },
        { $lookup: { from: posts, localField: '_id', foreignField: 'user_id', as: 'p' } },
        { $unwind: '$p' },
      ];
      if (multi) {
        stages.push(
          { $lookup: { from: likes, localField: 'p._id', foreignField: 'post_id', as: 'l' } },
          { $unwind: '$l' },
        );
      }
      if (spec.mode === 'cursor') stages.push({ $match: { [keyField]: { $gt: spec.after } } });
      stages.push({ $sort: { [keyField]: 1 } }, ...pageStages);
      return { type: 'agg', table: 'users', pipeline: stages };
    }

    // Otherwise drive from the many side: its _id is the unique row key.
    const table: SuiteTable = multi ? 'likes' : 'posts';
    const joins: Document[] = multi
      ? [
          { $lookup: { from: posts, localField: 'post_id', foreignField: '_id', as: 'p' } },
          { $unwind: '$p' },
          { $lookup: { from: users, localField: 'p.user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ]
      : [
          { $lookup: { from: users, localField: 'user_id', foreignField: '_id', as: 'u' } },
          { $unwind: '$u' },
        ];

    const stages: Document[] = [];
    if (spec.mode === 'cursor') stages.push({ $match: { _id: { $gt: spec.after } } });

    const needsUsersFirst = Object.keys(userMatch).length > 0 || spec.sort !== null;
    if (!needsUsersFirst) {
      // Nothing depends on the joined user, so page first and join only the page.
      stages.push({ $sort: { _id: 1 } }, ...pageStages, ...joins);
    } else {
      const prefixed: Document = {};
      for (const [k, v] of Object.entries(userMatch)) prefixed[`u.${k}`] = v;
      stages.push(...joins);
      if (Object.keys(prefixed).length > 0) stages.push({ $match: prefixed });
      stages.push(
        { $sort: spec.sort ? { [`u.${spec.sort.column}`]: 1, _id: 1 } : { _id: 1 } },
        ...pageStages,
      );
    }
    return { type: 'agg', table, pipeline: stages };
  }

  function aggPlan(spec: AggSpec): Plan {
    const count: Document = { $group: { _id: null, n: { $sum: 1 } } };
    switch (spec.kind) {
      case 'count-all':
        return { type: 'agg', table: 'users', pipeline: [count] };
      case 'count-indexed':
        return {
          type: 'agg',
          table: 'users',
          pipeline: [{ $match: { created_at: { $gte: spec.range!.from, $lte: spec.range!.to } } }, count],
        };
      case 'count-nonindexed':
        return {
          type: 'agg',
          table: 'users',
          pipeline: [{ $match: { score: { $lt: spec.scoreBelow! } } }, count],
        };
      case 'sum':
        return {
          type: 'agg',
          table: 'posts',
          pipeline: [{ $group: { _id: null, n: { $sum: '$views' } } }],
        };
      case 'posts-per-user':
        return {
          type: 'agg',
          table: 'users',
          pipeline: [
            { $lookup: { from: phys('posts'), localField: '_id', foreignField: 'user_id', as: 'p' } },
            { $project: { n: { $size: '$p' } } },
          ],
        };
      case 'likes-per-post':
        return {
          type: 'agg',
          table: 'posts',
          pipeline: [
            { $lookup: { from: phys('likes'), localField: '_id', foreignField: 'post_id', as: 'l' } },
            { $project: { n: { $size: '$l' } } },
          ],
        };
      case 'likes-per-user':
        return {
          type: 'agg',
          table: 'users',
          pipeline: [
            { $lookup: { from: phys('posts'), localField: '_id', foreignField: 'user_id', as: 'p' } },
            { $unwind: '$p' },
            { $lookup: { from: phys('likes'), localField: 'p._id', foreignField: 'post_id', as: 'l' } },
            { $group: { _id: '$_id', n: { $sum: { $size: '$l' } } } },
          ],
        };
    }
  }

  function textPlan(spec: TextSpec): Plan {
    const filter: Document =
      spec.pattern === 'fulltext'
        ? { $text: { $search: fullTextTerm(spec.limit) } }
        : { name: { $regex: regexTerm(spec.pattern, spec.limit) } };
    return { type: 'find', table: 'users', filter, sort: { _id: 1 }, skip: 0, limit: spec.limit };
  }

  function jsonPlan(spec: JsonSpec): Plan {
    const value = jsonMarker(spec.limit);
    const filter: Document =
      spec.filter === 'top'
        ? { tag: value }
        : spec.filter === 'nested'
          ? { [nestedPath(shape()).join('.')]: value }
          : { tags: value };
    return { type: 'find', table: 'documents', filter, sort: { _id: 1 }, skip: 0, limit: spec.limit };
  }

  const plan = (q: QueryKind): Plan => {
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
  };

  const asKey = (v: unknown): number | null => {
    const n = Number(v);
    return typeof v === 'number' && Number.isFinite(n) ? n : null;
  };

  const findCursor = (p: Extract<Plan, { type: 'find' }>) => {
    let cur = coll(p.table).find(p.filter, p.projection ? { projection: p.projection } : {}).sort(p.sort as never);
    if (p.skip > 0) cur = cur.skip(p.skip);
    if (p.limit > 0) cur = cur.limit(p.limit);
    return cur;
  };

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

    async bulkInsert(table, rows) {
      if (rows.length === 0) return;
      await coll(table).insertMany(rows.map((r) => toDoc(table, r)), { ordered: false });
    },

    async insertOne(table, row) {
      await coll(table).insertOne(toDoc(table, row));
    },

    isUniqueViolation(err) {
      return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === DUPLICATE_KEY;
    },

    async truncate(table) {
      await coll(table).deleteMany({});
    },

    async run(q): Promise<RunOut> {
      const p = plan(q);
      if (p.type === 'find') {
        const docs = await findCursor(p).toArray();
        return { rows: docs.length, lastKey: asKey(docs[docs.length - 1]?._id) };
      }
      const docs = await coll(p.table).aggregate(p.pipeline, { allowDiskUse: true }).toArray();
      return { rows: docs.length, lastKey: asKey(docs[docs.length - 1]?._id) };
    },

    async explain(q): Promise<ExplainOut> {
      const p = plan(q);
      const result =
        p.type === 'find'
          ? await findCursor(p).explain('queryPlanner')
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
