import type { EngineImpl, ImplOptions, QueryKind, ReadImpl, RunOut, SuiteAdapter } from '../types/specs.type.ts';

type ReadTest = 'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r8';

/**
 * A suite adapter with its reads and writes routed through the per-test
 * ReadImpl / WriteImpl. Everything else (schema, indexes, EXPLAIN) is the base suite's.
 */
export function withImpl(
  base: SuiteAdapter,
  create: (opts: ImplOptions) => EngineImpl,
): SuiteAdapter {
  let impl: EngineImpl | null = null;
  const current = (): EngineImpl => {
    if (!impl) throw new Error('suite used before resetSchema()');
    return impl;
  };

  const runRead = (q: QueryKind): Promise<RunOut> => {
    const read: ReadImpl = current().read;
    switch (q.kind) {
      case 'agg':
        return read.r7(q.spec);
      case 'text':
        return read.r9(q.spec);
      case 'json':
        return read.r10(q.spec);
      case 'read':
        // The test id on the spec picks the method; the spec is already narrowed by the builder.
        return read[q.spec.test as ReadTest](q.spec as never);
    }
  };

  return {
    ...base,

    async resetSchema(cfg, opts) {
      await base.resetSchema(cfg, opts);
      impl = create({ prefix: cfg.dataset.tablePrefix, docShape: cfg.reads.r10.docShape, config: cfg });
    },

    // Every plain single-row insert in the suite is a write test; the table names the test.
    insertOne(table, row) {
      const { write } = current();
      if (table === 'w_uk') return write.w2(table, row);
      if (table === 'w_docs') return write.w4(table, row);
      return write.w1(table, row);
    },

    bulkInsert: (table, rows) => (rows.length === 0 ? Promise.resolve() : current().write.w3(table, rows)),

    run: runRead,
  };
}
