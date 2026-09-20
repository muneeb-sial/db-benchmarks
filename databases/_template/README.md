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

## Engines worth adding

The interface is shaped for the SQL family, all of which should port with only
DDL changes:

| Engine | Driver | Notes |
| --- | --- | --- |
| MariaDB | `mariadb` or `mysql2` | Has no `innodb_dedicated_server`; the explicit buffer-pool knob is the only option. |
| MS SQL Server | `tedious` / `mssql` | Container refuses to start below ~2GB. **Needs `READ_COMMITTED_SNAPSHOT ON`** or the comparison is structurally unfair, since its READ COMMITTED locks rather than versions. Retry on 1205. |
| SQLite / libSQL | `better-sqlite3` / `@libsql/client` | Single-writer; the concurrency axis means something different. Say so in the results. |
| YugabyteDB | `postgres` | Postgres wire protocol — reuse `databases/postgres/adapter.ts` the way CockroachDB does. |
| TiDB | `mysql2` | MySQL wire protocol — reuse the MySQL adapter. |

**Cassandra** is deliberately absent. Through 5.x it cannot do the
cross-partition transaction this benchmark is built around: a logged `BATCH`
gives atomicity but no isolation, `LWT` is single-partition only, and counter
columns are non-idempotent so a retry after a timeout double-counts. Accord —
the genuine strict-serializable feature, often misreported as landing in 5.0 —
ships in **Cassandra 6**, is still pre-GA, and needs the Cluster Metadata
Service initialized first. Adding Cassandra means choosing which weaker
guarantee to measure and labelling it via `transactionality`.
