# Engine notes

What each engine does and doesn't run, and why.

## Cassandra: what it does and doesn't run

Through 5.x Cassandra cannot perform cross-partition transactions. A logged
`BATCH` gives atomicity but **no isolation**; `LWT` is single-partition only;
counter columns are non-idempotent, so a retry after a timeout double-counts.
Accord — the genuine strict-serializable feature, widely misreported as
shipping in 5.0 — arrives in **Cassandra 6**, is still pre-GA, and requires the
Cluster Metadata Service to be initialized first.

In the suite Cassandra runs what the engine can do
(inserts, unique-key inserts via LWT, key lookups, token-paged and indexed
reads) and reports the rest as `N/A` with a reason: joins, `OFFSET`, sorting,
text search and JSON.

## SQL Server

Runs everything except JSON (2022 has no JSON type) and full-text (the
container image ships without that component); both are recorded as `N/A`.
`READ_COMMITTED_SNAPSHOT` is switched on so its default locking `READ COMMITTED`
does not make the comparison structurally unfair against the engines that use
row versioning. SQL Server refuses to start below about 2 GB, so its cache is
50% of the container limit rather than 25%; the difference is recorded in every
result file.

## Elasticsearch: what it does and doesn't run

In the suite Elasticsearch runs everything except relational joins (`single-join`,
`multi-join` shapes), which have no equivalent in a document store and are
reported `N/A`. Text search and JSON documents — Elasticsearch's actual
strengths — run fully, including the aggregations that need a foreign key
but not a join (`posts`/`likes` already carry their parent id directly).
Being a single JVM, its heap is set to ~50% of the container memory limit
via `ES_JAVA_OPTS`, not the ~25% most other engines get, matching
Elasticsearch's own sizing guidance; the value is recorded in every result
file.
