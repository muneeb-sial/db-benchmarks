# Adding a database

Copy this folder to `databases/<engine>/`, fill in `adapter.ts`, and register it
in [`src/core/registry.ts`](../../src/core/registry.ts). Nothing else in the
harness needs to change.

## Checklist

**1. Declare honestly.** `supportedRuntimes` — only list a runtime you have
actually run against. Runtimes x databases is not a full grid; some drivers
fail on Bun. The harness skips and reports rather than crashing mid-run.

**2. Tune the memory knob.** The container cap alone does not level the field —
Postgres and MySQL sit at a hardcoded 128MB regardless of the cgroup, while
MongoDB sizes itself from it. Your compose file must set the engine's cache
explicitly, derived from the same `DB_MEM_LIMIT`, and `memoryConfig()` must
report it so the results stay reproducible.

**3. Provide the suite.** Set `suite` on the adapter (required) to run the
write/read suite ([docs/suite.md](../../docs/suite.md)). For a SQL engine
that is a `Dialect` in `src/sql/dialect.ts` plus a small `SqlExecutor` (see
`databases/mysql/adapter.ts`); everything else, including schema, indexes, query
building and the N/A rules, is shared. A non-SQL engine implements `SuiteAdapter`
directly (see `databases/mongodb/suite.ts`, `databases/cassandra/suite.ts`).
Return `na(reason)` from `support()` for anything the engine cannot do honestly.

## Engines already here

PostgreSQL, MySQL, MongoDB, CockroachDB, SQL Server, Cassandra and
Elasticsearch. Both Cassandra and Elasticsearch report what they cannot do as
`N/A` with a reason (Cassandra: joins, `OFFSET`, sorting; Elasticsearch: mainly
no relational joins).

## Engines worth adding

| Engine | Driver | Notes |
| --- | --- | --- |
| MariaDB | `mariadb` or `mysql2` | Has no `innodb_dedicated_server`; the explicit buffer-pool knob is the only option. Reuse the MySQL executor. |
| SQLite / libSQL | `better-sqlite3` / `@libsql/client` | Single-writer; the concurrency axis means something different. Say so in the results. |
| YugabyteDB | `postgres` | Postgres wire protocol — reuse `databases/postgres/adapter.ts` the way CockroachDB does. |
| TiDB | `mysql2` | MySQL wire protocol — reuse the MySQL adapter. |
| ScyllaDB | `cassandra-driver` | Same protocol and same limits as Cassandra; reuse `databases/cassandra/suite.ts`. |
