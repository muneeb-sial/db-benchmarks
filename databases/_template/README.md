# Adding a database

Copy this folder to `databases/<engine>/`, fill in `adapter.ts`, and register it
in [`src/core/registry.ts`](../../src/core/registry.ts). Nothing else in the
harness needs to change.

## Checklist

**1. Declare honestly.** Three fields decide whether your results are
comparable to everyone else's:

- `supportedRuntimes` — only list a runtime you have actually run against.
  Runtimes x databases is not a full grid; some drivers fail on Bun. The harness skips and reports rather than
  crashing mid-run.
- `capabilities.transactionality` — `acid` only if the engine really provides
  multi-statement isolation. A Cassandra logged `BATCH` is
  `atomic-not-isolated`, not `acid`.
- `isRetryable(err)` — which driver errors mean "the engine asked you to try
  again". Getting this wrong either hides contention (counting aborts as
  successes) or inflates it.

**2. Keep the lock order.** Every adapter updates `posts` **before** inserting
into `likes`. Varying that order makes deadlock rates a property of the adapter
rather than of the database.

**3. Tune the memory knob.** The container cap alone does not level the field —
Postgres and MySQL sit at a hardcoded 128MB regardless of the cgroup, while
MongoDB sizes itself from it. Your compose file must set the engine's cache
explicitly, derived from the same `DB_MEM_LIMIT`, and `memoryConfig()` must
report it so the results stay reproducible.

**4. Make `verifyCounters()` real.** It must count actual rows in `likes`, not
read back `like_count`. It is the check that catches an engine whose
transaction quietly did not hold — the whole benchmark leans on it.

**5. Add the suite (optional, and separate).** Set `suite` on the adapter to run
the write/read suite ([docs/suite.md](../../docs/suite.md)). For a SQL engine
that is a `Dialect` in `src/sql/dialect.ts` plus a small `SqlExecutor` (see
`databases/mysql/adapter.ts`); everything else, including schema, indexes, query
building and the N/A rules, is shared. A non-SQL engine implements `SuiteAdapter`
directly (see `databases/mongodb/suite.ts`, `databases/cassandra/suite.ts`).
Return `na(reason)` from `support()` for anything the engine cannot do honestly.
List workloads it cannot run in `capabilities.unsupportedWorkloads` (Cassandra
lists `like-tx`).

## Engines already here

PostgreSQL, MySQL, MongoDB, CockroachDB, SQL Server, Cassandra and
Elasticsearch. Cassandra skips `like-tx` because through 5.x it has no
cross-partition transaction (Accord ships in Cassandra 6, still pre-GA), and
reports the rest of what it cannot do as `N/A` with a reason. Elasticsearch
skips `like-tx` for a stronger reason -- it has no multi-document transaction
primitive at all -- but reports the rest as `N/A` the same way (mainly: no
relational joins).

## Engines worth adding

| Engine | Driver | Notes |
| --- | --- | --- |
| MariaDB | `mariadb` or `mysql2` | Has no `innodb_dedicated_server`; the explicit buffer-pool knob is the only option. Reuse the MySQL executor. |
| SQLite / libSQL | `better-sqlite3` / `@libsql/client` | Single-writer; the concurrency axis means something different. Say so in the results. |
| YugabyteDB | `postgres` | Postgres wire protocol — reuse `databases/postgres/adapter.ts` the way CockroachDB does. |
| TiDB | `mysql2` | MySQL wire protocol — reuse the MySQL adapter. |
| ScyllaDB | `cassandra-driver` | Same protocol and same limits as Cassandra; reuse `databases/cassandra/suite.ts`. |
