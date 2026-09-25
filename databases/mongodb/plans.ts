/**
 * MongoDB query planning: specs become either a find() or an aggregation pipeline.
 * Shared by the per-test impl (impl.ts) and the suite's explain (suite.ts).
 */

import type { Collection, Document } from 'mongodb';
import { fullTextTerm, jsonMarker, nestedPath, regexTerm } from '../../src/suite/data.ts';
import type { DocShape } from '../../src/types/config.type.ts';
import type { SuiteTable } from '../../src/types/schema.type.ts';
import type { AggSpec, JsonSpec, QueryKind, ReadSpec, RunOut, TextSpec } from '../../src/types/specs.type.ts';
import type { Plan } from '../../src/types/mongodb.type.ts';

export const USER_PROJECTION: Document = { email: 1, name: 1, score: 1, created_at: 1 };

export function createPlans(
  phys: (table: SuiteTable) => string,
  shape: () => DocShape,
  coll: (table: SuiteTable) => Collection,
) {
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

  const exec = async (p: Plan): Promise<RunOut> => {
    if (p.type === 'find') {
      const docs = await findCursor(p).toArray();
      return { rows: docs.length, lastKey: asKey(docs[docs.length - 1]?._id) };
    }
    const docs = await coll(p.table).aggregate(p.pipeline, { allowDiskUse: true }).toArray();
    return { rows: docs.length, lastKey: asKey(docs[docs.length - 1]?._id) };
  };

  return { readPlan, aggPlan, textPlan, jsonPlan, plan, findCursor, exec };
}
