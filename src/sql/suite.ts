/**
 * The suite adapter for every SQL engine.
 *
 * An engine supplies a Dialect (syntax) and a SqlExecutor (how to talk to its
 * driver). Everything else, including schema, indexes, query building and the
 * N/A rules, is shared, so adding a SQL engine to the suite is one small
 * executor rather than 40 methods.
 */

import { ALL_TABLES, TABLES, columnNames, rowToArray } from '../suite/schema.ts';
import { OK, na } from '../suite/specs.ts';
import { buildAgg, buildJson, buildRead, buildText, indexDdl, tableNames, usedIndex } from './queries.ts';
import type { DocShape, SuiteConfig } from '../types/config.type.ts';
import type { ColumnDef, SuiteRow, SuiteTable } from '../types/schema.type.ts';
import type { ExplainOut, Feature, IndexKind, QueryKind, SuiteAdapter, Support } from '../types/specs.type.ts';
import type { Dialect } from '../types/dialect.type.ts';
import type { Built, Names } from '../types/queries.type.ts';
import type { SqlExecutor } from '../types/sql-suite.type.ts';

export function createSqlSuite(d: Dialect, ex: SqlExecutor): SuiteAdapter {
  let cfg: SuiteConfig | null = null;
  let names: Names | null = null;
  let hasDocuments = false;

  const config = (): SuiteConfig => {
    if (!cfg) throw new Error(`${d.name} suite used before resetSchema()`);
    return cfg;
  };
  const t = (): Names => {
    if (!names) throw new Error(`${d.name} suite used before resetSchema()`);
    return names;
  };
  const prefix = (): string => config().dataset.tablePrefix;
  const physical = (table: SuiteTable): string => `${prefix()}${table}`;
  const docShape = (): DocShape => config().reads.r10.docShape;

  const build = (q: QueryKind): Built => {
    switch (q.kind) {
      case 'read':
        return buildRead(d, t(), q.spec);
      case 'agg':
        return buildAgg(d, t(), q.spec);
      case 'text':
        return buildText(d, t(), q.spec);
      case 'json':
        return buildJson(d, t(), q.spec, docShape());
    }
  };

  const jsonCast = (c: ColumnDef): string =>
    c.type === 'json' && (d.name === 'postgres' || d.name === 'cockroachdb') ? '::jsonb' : '';

  return {
    support(f: Feature): Support {
      if (f.kind === 'write') {
        if (f.test === 'w4' && !d.json) return na(`${d.name} has no native JSON document type`);
        return OK;
      }
      if (f.kind === 'json' && !d.json) return na(`${d.name} has no native JSON document type`);
      if (f.kind === 'text' && f.spec.pattern === 'fulltext' && !d.fullText) {
        return na(`no full-text search is configured for ${d.name}`);
      }
      return OK;
    },

    async resetSchema(c, opts) {
      cfg = c;
      names = tableNames(c.dataset.tablePrefix);
      hasDocuments = opts.documents && d.json;

      for (const table of ALL_TABLES) await ex.execute(d.dropTable(physical(table)));

      for (const table of ALL_TABLES) {
        if ((table === 'documents' || table === 'w_docs') && !hasDocuments) continue;
        const cols = TABLES[table].map((col) => {
          const parts = [col.name, d.type(col.type)];
          parts.push(col.pk ? 'not null primary key' : 'not null');
          if (col.unique) parts.push('unique');
          return parts.join(' ');
        });
        await ex.execute(`create table ${physical(table)} (${cols.join(', ')})`);
      }
    },

    async afterLoad() {
      const p = prefix();
      const n = t();
      const statements = [
        `create index ${p}users_created_idx on ${n.users} (created_at)`,
        `create index ${p}posts_user_idx on ${n.posts} (user_id)`,
        `create index ${p}posts_created_idx on ${n.posts} (created_at)`,
        `create index ${p}likes_post_idx on ${n.likes} (post_id)`,
        `create index ${p}likes_user_idx on ${n.likes} (user_id)`,
      ];
      for (const s of statements) await ex.execute(s);

      // Fresh planner statistics, so plans reflect the loaded data rather than an empty table.
      if (d.name === 'postgres') await ex.execute('analyze');
      if (d.name === 'mysql') await ex.execute(`analyze table ${n.users}, ${n.posts}, ${n.likes}`);
    },

    async bulkInsert(table, rows) {
      if (rows.length === 0) return;
      await ex.bulkInsert(
        physical(table),
        TABLES[table],
        rows.map((r) => rowToArray(table, r)),
      );
    },

    async insertOne(table, row: SuiteRow) {
      const cols = TABLES[table];
      const placeholders = cols.map((c, i) => `${d.ph(i + 1)}${jsonCast(c)}`).join(', ');
      await ex.write(
        `insert into ${physical(table)} (${columnNames(table).join(', ')}) values (${placeholders})`,
        rowToArray(table, row),
      );
    },

    isUniqueViolation: (err) => ex.isUniqueViolation(err),

    async truncate(table) {
      await ex.execute(`truncate table ${physical(table)}`);
    },

    async run(q) {
      const b = build(q);
      return ex.query(b.sql, b.params);
    },

    async explain(q): Promise<ExplainOut> {
      const b = build(q);
      const text = await ex.explain(b.sql, b.params);
      return { text, indexUsed: usedIndex(d, text) };
    },

    async createIndex(kind: IndexKind) {
      await ex.execute(indexDdl(d, t(), prefix(), kind, docShape()).create);
    },

    async dropIndex(kind: IndexKind) {
      await ex.execute(indexDdl(d, t(), prefix(), kind, docShape()).drop);
    },

    async indexSizeBytes(kind: IndexKind): Promise<number | null> {
      const ddl = indexDdl(d, t(), prefix(), kind, docShape());
      const table = kind.startsWith('json') ? physical('documents') : physical('users');
      try {
        if (d.name === 'postgres') {
          return await ex.scalar(`select pg_relation_size('${ddl.name}')`);
        }
        if (d.name === 'mysql') {
          return await ex.scalar(
            `select stat_value * @@innodb_page_size from mysql.innodb_index_stats ` +
              `where database_name = database() and table_name = '${table}' ` +
              `and index_name = '${ddl.name}' and stat_name = 'size'`,
          );
        }
        if (d.name === 'mssql') {
          return await ex.scalar(
            `select sum(ps.used_page_count) * 8192 from sys.dm_db_partition_stats ps ` +
              `join sys.indexes i on i.object_id = ps.object_id and i.index_id = ps.index_id ` +
              `where i.name = '${ddl.name}'`,
          );
        }
      } catch {
        // Size is informational; some engines or privileges cannot report it.
      }
      return null;
    },
  };
}
