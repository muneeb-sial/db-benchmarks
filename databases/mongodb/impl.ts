/**
 * MongoDB implementation of ReadImpl and WriteImpl: one method per suite test.
 * Reads run the plan built in plans.ts; writes go straight to the collection.
 */

import type { Db, Document } from 'mongodb';
import type { SuiteRow, SuiteTable } from '../../src/types/schema.type.ts';
import type { EngineImpl, ImplOptions, ReadImpl, WriteImpl } from '../../src/types/specs.type.ts';
import { createPlans } from './plans.ts';

export function toDoc(table: SuiteTable, row: SuiteRow): Document {
  if (table === 'documents' || table === 'w_docs') {
    return { _id: row.id, ...(row.doc as Document) };
  }
  const { id, ...rest } = row;
  return { _id: id, ...rest };
}

export function createMongoImpl(getDb: () => Db, opts: ImplOptions): EngineImpl {
  const phys = (table: SuiteTable): string => `${opts.prefix}${table}`;
  const coll = (table: SuiteTable) => getDb().collection(phys(table));
  const p = createPlans(phys, () => opts.docShape, coll);

  const insertOne = async (table: SuiteTable, row: SuiteRow): Promise<void> => {
    await coll(table).insertOne(toDoc(table, row));
  };

  const write: WriteImpl = {
    w1: insertOne,
    // A duplicate email raises E11000; the runner counts it via isUniqueViolation.
    w2: insertOne,
    w3: async (table, rows) => {
      await coll(table).insertMany(rows.map((r) => toDoc(table, r)), { ordered: false });
    },
    w4: insertOne,
  };

  const read: ReadImpl = {
    r1: (spec) => p.exec(p.readPlan(spec)),
    r2: (spec) => p.exec(p.readPlan(spec)),
    r3: (spec) => p.exec(p.readPlan(spec)),
    r4: (spec) => p.exec(p.readPlan(spec)),
    r5: (spec) => p.exec(p.readPlan(spec)),
    r6: (spec) => p.exec(p.readPlan(spec)),
    r7: (spec) => p.exec(p.aggPlan(spec)),
    r8: (spec) => p.exec(p.readPlan(spec)),
    r9: (spec) => p.exec(p.textPlan(spec)),
    r10: (spec) => p.exec(p.jsonPlan(spec)),
  };

  return { read, write };
}
