# Engine notes

What each engine does and doesn't run, and why.

## Cassandra: what it does and doesn't run

Through 5.x Cassandra cannot perform the cross-partition transaction the like
workload is built around. A logged `BATCH` gives atomicity but **no
isolation**; `LWT` is single-partition only; counter columns are
non-idempotent, so a retry after a timeout double-counts. Accord — the genuine
strict-serializable feature, widely misreported as shipping in 5.0 — arrives in
**Cassandra 6**, is still pre-GA, and requires the Cluster Metadata Service to
be initialized first.

So Cassandra is included, but **`like-tx` and `top-posts` are skipped for it**,
with the reason recorded in the results, rather than benchmarking a weaker
operation that looks comparable. In the suite it runs what the engine can do
(inserts, unique-key inserts via LWT, key lookups, token-paged and indexed
reads) and reports the rest as `N/A` with a reason: joins, `OFFSET`, sorting,
text search and JSON. The adapter contract carries a `transactionality` field
so its numbers can never be silently compared against Postgres'.

## SQL Server

Runs everything except JSON (2022 has no JSON type) and full-text (the
container image ships without that component); both are recorded as `N/A`.
`READ_COMMITTED_SNAPSHOT` is switched on so its default locking `READ COMMITTED`
does not make the comparison structurally unfair against the engines that use
row versioning. SQL Server refuses to start below about 2 GB, so its cache is
50% of the container limit rather than 25%; the difference is recorded in every
result file.

## Elasticsearch: what it does and doesn't run

Elasticsearch has no multi-document transaction primitive at all — not even
Cassandra's weaker "atomic but not isolated" logged `BATCH`. A single document
write is atomic; the like and the post's counter, as two documents, never are
together. So **`like-tx` is skipped for it**, with the reason recorded in the
results; its `transactionality` is `none`, so its numbers can never be
silently compared against an ACID engine's. `top-posts`, unlike on Cassandra,
**is** supported: sorting by a numeric field the index already has is exactly
what Elasticsearch is fast at.

In the suite it runs everything except relational joins (`single-join`,
`multi-join` shapes), which have no equivalent in a document store and are
reported `N/A`. Text search and JSON documents — Elasticsearch's actual
strengths — run fully, including the aggregations that need a foreign key
but not a join (`posts`/`likes` already carry their parent id directly).
Being a single JVM, its heap is set to ~50% of the container memory limit
via `ES_JAVA_OPTS`, not the ~25% most other engines get, matching
Elasticsearch's own sizing guidance; the value is recorded in every result
file.
