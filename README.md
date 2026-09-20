# db-benchmarks

Benchmarks for **PostgreSQL**, **MySQL**, **MongoDB**, **CockroachDB**,
**SQL Server** and **Cassandra**, written once in TypeScript and runnable
unmodified on **Node** and **Bun**. Deno is not supported.

Two things run here:

- **The transactional workload.** A *like*: insert a row into `likes` **and**
  increment the denormalized `posts.like_count`, atomically, under controlled
  concurrency and controlled contention.
- **The write/read suite** ([docs/suite.md](docs/suite.md)). Writes W1-W4 and
  reads R1-R10 across three query shapes, three read modes, six limits and five
  concurrency levels, with every number set in
  [bench.config.json](bench.config.json). Run it with `--suite`.

## What this measures, and why

Most database comparisons insert some rows, time a few `SELECT`s, and publish a
table. That mostly measures the driver and whatever cache the container
happened to get. This one is built around three ideas:

**1. Correctness is part of the result.** After the like workload, every
engine's stored `like_count` is compared against an actual count of that post's
likes. An engine whose transaction quietly didn't hold — MongoDB pointed at a
standalone node, a missed CockroachDB retry — fails this check, and the
benchmark exits non-zero. *A database that is fast because it didn't do the
work does not win.*

**2. Contention is the interesting axis.** Every transactional workload runs
twice: `uniform`, where likes spread across every post, and `hot`, where they
concentrate on ten. The gap between them is where engines genuinely diverge —
row-lock queueing, optimistic-retry storms, write conflicts. Retries are
reported as a metric, because a contention benchmark that hides them is
meaningless.

**3. The memory budget is stated, and equalized.** See below.

## The memory trap

Capping a container is not enough to make a fair comparison, because these
engines do not agree on where their cache size comes from:

| Engine | Default cache | Reads the cgroup limit? | Under a bare `mem_limit: 4g` |
| --- | --- | --- | --- |
| PostgreSQL | `shared_buffers` = 128MB, hardcoded | No | uses **128MB** |
| MySQL | `innodb_buffer_pool_size` = 128MB, hardcoded | No | uses **128MB** |
| MongoDB | `max(50% of (RAM − 1GB), 256MB)` | **Yes** | uses **~1.5GB** |

So a naive memory limit hands MongoDB a **12× larger cache** than the other
two, and the resulting table looks like MongoDB being fast. Every compose file
here therefore sets the engine's cache explicitly, derived from the same
`DB_MEM_LIMIT`, and every run records what it used.

## Quick start

Requires **Node ≥ 22.18.0** (the release where TypeScript type-stripping became
default-on) or Bun 1.2.21+, plus Docker with Compose v2. Running under Deno exits
with an error.

```bash
npm ci

# Start one database -- each owns its own compose file
cd databases/postgres && docker compose up -d --wait && cd ../..

# Run it
node src/cli.ts --db postgres --workload like-tx --duration 10
```

Same source, other runtimes:

```bash
bun src/cli.ts --db postgres
```

The write/read suite, at a glance:

```bash
node src/cli.ts --suite --profile smoke --db postgres      # quick end-to-end check
node src/cli.ts --suite --db postgres --tests r1,r4,w3     # a slice of the matrix
```

`node src/cli.ts --help` lists every flag. More recipes (all databases, read
workloads, memory limits, troubleshooting) are in [how-to-run.md](how-to-run.md).

## Memory limits

Each `databases/<engine>/docker-compose.yml` defaults to **4 GiB** and is
overridable without editing the file:

```bash
# up
DB_MEM_LIMIT=8g PG_SHARED_BUFFERS=2GB PG_EFFECTIVE_CACHE=6GB docker compose up -d

# down
DB_MEM_LIMIT=2g PG_SHARED_BUFFERS=512MB PG_EFFECTIVE_CACHE=1536MB docker compose up -d
```

…or drop a `.env` file next to the compose file. Each compose file documents
its own engine's knob at the top.

Two rules:

- **Move the cache knob with the limit.** Compose cannot do arithmetic, so the
  engine cache is a second variable. Keep it around 25% of `DB_MEM_LIMIT` so
  every engine gets the same working memory. CockroachDB is the exception — it
  takes a fraction and *is* cgroup-aware, so it tracks automatically.
- **`memswap_limit` is set equal to `mem_limit` on purpose.** Without it Docker
  grants swap equal to the limit, and a "4g" container quietly gets 4g RAM plus
  4g swap.

Verify a cap actually bound:

```bash
docker inspect -f '{{.HostConfig.Memory}}' bench-postgres-postgres-1
docker exec bench-postgres-postgres-1 psql -U postgres -d benchmark -c 'show shared_buffers'
```

## Layout

```
src/core/       adapter contract, closed-loop runner, stats, retry, reporting
src/dataset/    seeded user/post generation (like-tx)
src/workloads/  like-tx (with contention modes) and read workloads
src/suite/      the write/read suite: config, data, test matrix, runner, reports
src/sql/        SQL dialects and the query builder shared by the SQL engines
databases/      one folder per engine: adapter.ts + docker-compose.yml (+ suite.ts)
databases/_template/   how to add an engine
bench.config.json      every number the suite uses
docs/suite.md          the suite: each test, its configuration and results
results/        <run-id>/result.json, result.md, and the suite's tables/charts
```

Adding a database means copying `databases/_template/` and adding one line to
`src/core/registry.ts`. See that folder's README for the checklist.

## Schema

```
users (id, first_name, last_name, email UNIQUE, password, age, gender, ...)
posts (id, user_id, title, body, like_count, ...)
likes (user_id, post_id, created_at)   PRIMARY KEY (user_id, post_id)
```

The like transaction, in every engine:

```sql
BEGIN;
  UPDATE posts SET like_count = like_count + 1 WHERE id = ?;
  INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, now());
COMMIT;
```

`posts` is always touched before `likes`. Every adapter uses that same order,
so deadlock rates are a property of the database rather than of the adapter.

IDs are assigned by the generator rather than by auto-increment, so the
workload can pick a post without a round trip and the same IDs exist in every
engine.

## Methodology and caveats

- **Closed loop.** Exactly N workers each run operations sequentially until a
  deadline, rather than `Promise.all` over thousands of rows — which measures
  pool saturation, not latency. The trade-off is that a closed loop understates
  latency under overload (*coordinated omission*), so these numbers are
  **comparative between engines, not absolute service levels**.
- Warmup samples are discarded; each cell repeats and reports the median.
- **MongoDB runs as a single-node replica set**, which is mandatory for
  multi-document transactions. That also means `w:majority` is satisfied by one
  node, so it pays no replication cost here. Recorded in every result file.
- **MySQL is pinned to `READ-COMMITTED`** to match Postgres' default. At its own
  default of `REPEATABLE READ`, the insert into `likes` takes gap locks and the
  comparison would be measuring isolation level rather than engine.
- Benchmarks are **not** run in CI. Shared runners are noisy neighbours; CI only
  typechecks and smoke-tests both runtimes. Numbers come from local runs on
  known hardware.
- Results below were produced on one machine. Run it on yours before drawing
  conclusions.

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

## Latest results

Regenerate with `node scripts/render-results.ts`.

<!-- start -->
<!-- end -->

## History

Earlier text-format results from the original Node-only harness are kept in
[`results/`](results) as an archive. They are not comparable to current runs:
they used a different schema, unbounded concurrency, and untuned container
memory.

## License

MIT — see [LICENSE](LICENSE).
