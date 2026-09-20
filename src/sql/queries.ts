/**
 * Renders logical specs into SQL for any Dialect.
 *
 * The three query shapes are always the same joins:
 *   simple       users u
 *   single-join  users u JOIN posts p ON p.user_id = u.id
 *   multi-join   ... JOIN likes l ON l.post_id = p.id
 *
 * Each shape orders (and cursors) on the key of its most numerous side, because
 * that is the only key unique per returned row: u.id, p.id, l.id.
 */

import type { Dialect } from './dialect.ts';
import type { DocShape, Shape } from '../suite/config.ts';
import { fullTextTerm, jsonMarker, likeTerm, nest, nestedPath } from '../suite/data.ts';
import type {
  AggSpec,
  IndexKind,
  JsonSpec,
  ReadSpec,
  RunOut,
  TextSpec,
} from '../suite/specs.ts';

export interface Names {
  users: string;
  posts: string;
  likes: string;
  documents: string;
}

export const tableNames = (prefix: string): Names => ({
  users: `${prefix}users`,
  posts: `${prefix}posts`,
  likes: `${prefix}likes`,
  documents: `${prefix}documents`,
});

export interface Built {
  sql: string;
  params: unknown[];
}

const KEY: Record<Shape, string> = {
  simple: 'u.id',
  'single-join': 'p.id',
  'multi-join': 'l.id',
};

function fromClause(t: Names, shape: Shape): string {
  const base = `${t.users} u`;
  if (shape === 'simple') return base;
  const withPosts = `${base} join ${t.posts} p on p.user_id = u.id`;
  if (shape === 'single-join') return withPosts;
  return `${withPosts} join ${t.likes} l on l.post_id = p.id`;
}

function selectList(shape: Shape): string {
  const base = 'u.id, u.email, u.name, u.score, u.created_at';
  if (shape === 'simple') return base;
  const withPosts = `${base}, p.id as post_id, p.title, p.views`;
  if (shape === 'single-join') return withPosts;
  return `${withPosts}, l.id as like_id, l.created_at as liked_at`;
}

export function buildRead(d: Dialect, t: Names, spec: ReadSpec): Built {
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return d.ph(params.length);
  };

  const key = KEY[spec.shape];
  const where: string[] = [];
  const f = spec.filter;
  switch (f.kind) {
    case 'none':
      break;
    case 'email':
      where.push(`u.email = ${add(f.value)}`);
      break;
    case 'scoreBelow':
      where.push(`u.score < ${add(f.value)}`);
      break;
    case 'range': {
      const a = add(f.from);
      const b = add(f.to);
      where.push(`u.created_at between ${a} and ${b}`);
      break;
    }
    case 'id':
      where.push(`u.id = ${add(f.value)}`);
      break;
    case 'ids':
      where.push(`u.id in (${f.values.map((v) => add(v)).join(', ')})`);
      break;
    case 'idCap':
      where.push(`u.id <= ${Math.trunc(f.cap)}`);
      break;
  }
  if (spec.mode === 'cursor') where.push(`${key} > ${add(spec.after)}`);

  const order = spec.sort ? `u.${spec.sort.column}, ${key}` : key;
  const offset = spec.mode === 'offset' ? spec.offset : 0;

  const sql =
    `select ${selectList(spec.shape)}, ${key} as k_ from ${fromClause(t, spec.shape)}` +
    (where.length > 0 ? ` where ${where.join(' and ')}` : '') +
    ` order by ${order}${d.pageClause(spec.limit, offset)}`;

  return { sql, params };
}

export function buildAgg(d: Dialect, t: Names, spec: AggSpec): Built {
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return d.ph(params.length);
  };

  switch (spec.kind) {
    case 'count-all':
      return { sql: `select count(*) as n from ${t.users}`, params };
    case 'count-indexed': {
      const r = spec.range!;
      const a = add(r.from);
      const b = add(r.to);
      return { sql: `select count(*) as n from ${t.users} where created_at between ${a} and ${b}`, params };
    }
    case 'count-nonindexed':
      return {
        sql: `select count(*) as n from ${t.users} where score < ${add(spec.scoreBelow!)}`,
        params,
      };
    case 'sum':
      return { sql: `select sum(views) as n from ${t.posts}`, params };
    case 'posts-per-user':
      return {
        sql:
          `select u.id, count(p.id) as n from ${t.users} u ` +
          `join ${t.posts} p on p.user_id = u.id group by u.id`,
        params,
      };
    case 'likes-per-post':
      return {
        sql:
          `select p.id, count(l.id) as n from ${t.posts} p ` +
          `join ${t.likes} l on l.post_id = p.id group by p.id`,
        params,
      };
    case 'likes-per-user':
      return {
        sql:
          `select u.id, count(l.id) as n from ${t.users} u ` +
          `join ${t.posts} p on p.user_id = u.id ` +
          `join ${t.likes} l on l.post_id = p.id group by u.id`,
        params,
      };
  }
}

export function buildText(d: Dialect, t: Names, spec: TextSpec): Built {
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return d.ph(params.length);
  };

  let cond: string;
  if (spec.pattern === 'fulltext') {
    const term = fullTextTerm(spec.limit);
    cond =
      d.name === 'mysql'
        ? `match(bio) against (${add(term)} in boolean mode)`
        : `to_tsvector('english', bio) @@ plainto_tsquery('english', ${add(term)})`;
  } else {
    cond = `name like ${add(likeTerm(spec.pattern, spec.limit))}`;
  }

  return {
    sql: `select id, name, id as k_ from ${t.users} where ${cond} order by id${d.pageClause(spec.limit, 0)}`,
    params,
  };
}

function containment(filter: JsonSpec['filter'], value: string, shape: DocShape): Record<string, unknown> {
  if (filter === 'top') return { tag: value };
  if (filter === 'nested') return nest(shape, value);
  return { tags: [value] };
}

export function buildJson(d: Dialect, t: Names, spec: JsonSpec, shape: DocShape): Built {
  const params: unknown[] = [];
  const add = (v: unknown): string => {
    params.push(v);
    return d.ph(params.length);
  };
  const value = jsonMarker(spec.limit);

  let cond: string;
  if (d.name === 'mysql') {
    if (spec.filter === 'top') {
      cond = `cast(doc->>'$.tag' as char(64)) = ${add(value)}`;
    } else if (spec.filter === 'nested') {
      cond = `cast(doc->>'$.${nestedPath(shape).join('.')}' as char(64)) = ${add(value)}`;
    } else {
      cond = `${add(value)} member of (doc->'$.tags')`;
    }
  } else {
    // Postgres and CockroachDB: one containment operator serves all three filter
    // types, and it is exactly what a GIN / inverted index accelerates. The
    // parameter is passed as an object; the driver serializes it as jsonb.
    cond = `doc @> ${add(containment(spec.filter, value, shape))}::jsonb`;
  }

  return {
    sql: `select id, id as k_ from ${t.documents} where ${cond} order by id${d.pageClause(spec.limit, 0)}`,
    params,
  };
}

export interface IndexDdl {
  name: string;
  create: string;
  drop: string;
}

export function indexDdl(d: Dialect, t: Names, prefix: string, kind: IndexKind, shape: DocShape): IndexDdl {
  const name = `${prefix}ix_${kind.replace(/-/g, '_')}`;
  const onUsers = t.users;
  const onDocs = t.documents;

  const drop = (table: string): string => {
    if (d.name === 'postgres') return `drop index if exists ${name}`;
    if (d.name === 'cockroachdb') return `drop index if exists ${table}@${name}`;
    return `drop index ${name} on ${table}`;
  };

  switch (kind) {
    case 'text-name':
      return {
        name,
        // text_pattern_ops is what lets Postgres use a btree for LIKE 'abc%'
        // under a non-C collation. Other engines use the plain index.
        create: `create index ${name} on ${onUsers} (name${d.name === 'postgres' ? ' text_pattern_ops' : ''})`,
        drop: drop(onUsers),
      };
    case 'text-fulltext':
      return {
        name,
        create:
          d.name === 'mysql'
            ? `create fulltext index ${name} on ${onUsers} (bio)`
            : `create index ${name} on ${onUsers} using gin (to_tsvector('english', bio))`,
        drop: drop(onUsers),
      };
    case 'json-top':
    case 'json-nested':
    case 'json-array': {
      if (d.name === 'mysql') {
        const expr =
          kind === 'json-top'
            ? `cast(doc->>'$.tag' as char(64))`
            : kind === 'json-nested'
              ? `cast(doc->>'$.${nestedPath(shape).join('.')}' as char(64))`
              : `cast(doc->'$.tags' as char(64) array)`;
        return { name, create: `create index ${name} on ${onDocs} ((${expr}))`, drop: drop(onDocs) };
      }
      return {
        name,
        create:
          d.name === 'cockroachdb'
            ? `create inverted index ${name} on ${onDocs} (doc)`
            : `create index ${name} on ${onDocs} using gin (doc)`,
        drop: drop(onDocs),
      };
    }
  }
}

/** Row count and last cursor key from a driver's result rows. */
export function toRunOut(rows: ArrayLike<unknown>): RunOut {
  const n = rows.length;
  const last = n > 0 ? (rows[n - 1] as { k_?: unknown } | undefined) : undefined;
  const k = last?.k_ === undefined || last?.k_ === null ? NaN : Number(last.k_);
  return { rows: n, lastKey: Number.isFinite(k) ? k : null };
}

/** Best-effort "did the plan use an index" from an engine's EXPLAIN text. */
export function usedIndex(d: Dialect, text: string): boolean | null {
  switch (d.name) {
    case 'postgres':
      return /Index (Only )?Scan|Bitmap Index Scan/i.test(text);
    case 'cockroachdb':
      return /\bscan\b/i.test(text) ? !/FULL SCAN/i.test(text) : null;
    case 'mssql':
      return /Index Seek|Clustered Index Seek/i.test(text);
    case 'mysql':
      try {
        const rows: unknown = JSON.parse(text);
        return Array.isArray(rows)
          ? rows.some((r) => (r as { key?: unknown }).key !== null && (r as { key?: unknown }).key !== undefined)
          : null;
      } catch {
        return null;
      }
  }
}
