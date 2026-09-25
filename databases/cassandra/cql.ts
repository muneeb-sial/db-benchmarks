/** CQL text and bound parameters for each suite query. Shared by impl.ts and the suite's explain. */

import type { ReadSpec, QueryKind } from '../../src/types/specs.type.ts';
import type { SuiteTable } from '../../src/types/schema.type.ts';

const USER_COLS = 'id, email, name, score, created_at';

export class UniqueViolation extends Error {}

export interface Cql {
  text: string;
  params: unknown[];
}

export function createCql(table: (t: SuiteTable) => string) {
  /** CQL text and bound parameters for a query. */
  function cql(q: QueryKind): Cql {
    if (q.kind === 'agg') {
      const s = q.spec;
      const users = table('users');
      switch (s.kind) {
        case 'count-all':
          return { text: `select count(*) as n from ${users}`, params: [] };
        case 'count-indexed':
          return {
            text: `select count(*) as n from ${users} where created_at >= ? and created_at <= ?`,
            params: [s.range!.from, s.range!.to],
          };
        case 'count-nonindexed':
          return {
            text: `select count(*) as n from ${users} where score < ? allow filtering`,
            params: [s.scoreBelow!],
          };
        case 'sum':
          return { text: `select sum(views) as n from ${table('posts')}`, params: [] };
        default:
          throw new Error(`cassandra cannot run ${s.kind}`);
      }
    }
    if (q.kind !== 'read') throw new Error(`cassandra cannot run ${q.kind} queries`);
    return readCql(q.spec);
  }

  function readCql(spec: ReadSpec): Cql {
    const users = table('users');
    const limit = spec.limit !== null ? ` limit ${spec.limit}` : '';
    const f = spec.filter;
    switch (f.kind) {
      case 'none':
        return spec.mode === 'cursor'
          ? {
              text: `select ${USER_COLS} from ${users} where token(id) > token(?)${limit}`,
              params: [spec.after],
            }
          : { text: `select ${USER_COLS} from ${users}${limit}`, params: [] };
      case 'email':
        return { text: `select ${USER_COLS} from ${users} where email = ?${limit}`, params: [f.value] };
      case 'scoreBelow':
        // Deliberately unindexed: a full scan, which is what R3 measures.
        return {
          text: `select ${USER_COLS} from ${users} where score < ?${limit} allow filtering`,
          params: [f.value],
        };
      case 'range':
        return {
          text: `select ${USER_COLS} from ${users} where created_at >= ? and created_at <= ?${limit}`,
          params: [f.from, f.to],
        };
      case 'id':
        return { text: `select ${USER_COLS} from ${users} where id = ?`, params: [f.value] };
      case 'ids':
        return {
          text: `select ${USER_COLS} from ${users} where id in (${f.values.map(() => '?').join(', ')})`,
          params: f.values,
        };
      case 'idCap':
        throw new Error('cassandra cannot run a capped full sort');
    }
  }

  return { cql, readCql };
}
