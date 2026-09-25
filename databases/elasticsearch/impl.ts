/**
 * Elasticsearch implementation of ReadImpl and WriteImpl: one method per suite test.
 * Reads run the request built in plans.ts; writes go through the index / bulk APIs.
 */

import { Client, errors } from '@elastic/elasticsearch';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { EngineImpl, ImplOptions, QueryKind, ReadImpl, WriteImpl } from '../../src/types/specs.type.ts';
import { createPlans, idFor, maxResultWindowFor, toSource } from './plans.ts';

const UNIQUE_STATUS = 409;

export class UniqueViolation extends Error {}

function isConflict(err: unknown): boolean {
  return err instanceof errors.ResponseError && err.meta.statusCode === UNIQUE_STATUS;
}

export function createElasticsearchImpl(getClient: () => Client, opts: ImplOptions): EngineImpl {
  const index = (t: SuiteTable): string => `${opts.prefix}${t}`;
  const window = maxResultWindowFor(opts.config);
  const p = createPlans(getClient, index, () => opts.docShape, () => window);

  const insertOne = async (t: SuiteTable, row: SuiteRow): Promise<void> => {
    try {
      await getClient().index({
        index: index(t),
        id: idFor(t, row),
        document: toSource(t, row),
        op_type: 'create',
      });
    } catch (err) {
      // W2 relies on this: `create` on an existing _id (the email) is a 409.
      if (isConflict(err)) throw new UniqueViolation('duplicate email');
      throw err;
    }
  };

  const write: WriteImpl = {
    w1: insertOne,
    w2: insertOne,
    w3: async (t, rows) => {
      const operations = rows.flatMap((r) => [
        { index: { _index: index(t), _id: idFor(t, r) } },
        toSource(t, r),
      ]);
      await getClient().bulk({ operations, refresh: false });
    },
    w4: insertOne,
  };

  const run = (q: QueryKind) => p.exec(q);
  const read: ReadImpl = {
    r1: (spec) => run({ kind: 'read', spec }),
    r2: (spec) => run({ kind: 'read', spec }),
    r3: (spec) => run({ kind: 'read', spec }),
    r4: (spec) => run({ kind: 'read', spec }),
    r5: (spec) => run({ kind: 'read', spec }),
    r6: (spec) => run({ kind: 'read', spec }),
    r7: (spec) => run({ kind: 'agg', spec }),
    r8: (spec) => run({ kind: 'read', spec }),
    r9: (spec) => run({ kind: 'text', spec }),
    r10: (spec) => run({ kind: 'json', spec }),
  };

  return { read, write };
}
