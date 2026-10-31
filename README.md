# db-benchmarks

Benchmarks for **PostgreSQL**, **MySQL**, **MongoDB**, **CockroachDB**,
**SQL Server**, **Cassandra** and **Elasticsearch**.

The pieces:
- A **Bun HTTP server** runs one database operation per request.
- **k6** drives the concurrency and does the timing.
- A **web page** lets you run a single test or a whole suite and watch it stream.

Everything lives in [src/](src/README.md).

Two kinds of test run here:

- **The like transaction:** insert a row into `likes` **and** increment the
  denormalized `posts.like_count`, atomically, under uniform and hot
  contention.
- **The write/read suite:**
  - writes W1–W4 and reads R1–R10
  - across three query shapes, three read modes and the configured limits
  - at each concurrency level
  - with every number in [src/config/bench.config.json](src/config/bench.config.json)

## Quick start

Requires [Bun](https://bun.sh) 1.2.3+, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
and Docker with Compose v2.

```bash
bun install
bun run seed                          # seed files, once per profile (--profile smoke for a small one)
bun run server                        # http://localhost:3000
```

Open **http://localhost:3000**, pick a database and click **Reinitialize**.
That recreates the container, loads the seed and builds the indexes. Then run
a single test, or switch to the **Suite** tab for many tests at once.

The same suite from a terminal:

```bash
bun run bench --db postgres,mysql --tests r1,r2,w1 --concurrency 1,8,32
```

Full usage, the API, tests, coverage and indexes are in
[src/README.md](src/README.md).

## What this measures, and why

Most database comparisons insert some rows, time a few `SELECT`s, and publish a
table. That mostly measures the driver and whatever cache the container
happened to get. This one is built around four ideas:

**1. Correctness is part of the result.** After a like-transaction run, each
engine's stored `like_count` is compared against a real count of that post's
likes. An engine whose transaction quietly didn't hold fails this check, and
the run fails. Examples: MongoDB pointed at a standalone node, or a missed
CockroachDB retry. *A database that is fast because it didn't do the work does
not win.*

**2. Contention is the interesting axis.** The like transaction runs twice:
- `uniform`, where likes spread across every post
- `hot`, where they concentrate on ten

The gap between the two is where engines really diverge: row-lock queueing,
optimistic-retry storms, write conflicts.

**3. The memory budget is stated, and equalized.** A container cap alone isn't
fair. Postgres and MySQL keep a hardcoded 128MB cache whatever the cap is,
while MongoDB sizes itself from it, and so would get about **12× more cache**
under the same 4 GiB. Each compose file therefore sets the engine's cache
explicitly from the same `DB_MEM_LIMIT`. See
[src/databases/](src/databases/README.md).

**4. Anything an engine can't do honestly is N/A, with the reason.** Nothing
is faked or quietly replaced with something weaker. Examples: Cassandra has no
joins or cross-partition transaction, SQL Server 2022 has no JSON type, and
Elasticsearch has no transactions.

## Methodology and caveats

- **Every run starts from a fresh container.** Initialize runs
  `docker compose down -v` then `up -d --wait`, so no state carries over.
- **Two latencies.** `http_req_duration` is what k6 saw end to end. `db_ms` is
  the server's own timing of the database call alone, sent back in the
  `Server-Timing` header.
- **Closed loop.** k6's `constant-vus` keeps N workers busy, which understates
  latency under overload (*coordinated omission*). Treat the numbers as
  comparisons between engines, not absolute service levels.
- **Fairness settings, recorded per engine:**
  - MySQL is pinned to `READ-COMMITTED` to match Postgres.
  - SQL Server runs with `READ_COMMITTED_SNAPSHOT` on.
  - MongoDB runs as a single-node replica set (required for transactions;
    `w: majority` costs no replication on one node).
- **Single machine.** Results come from one machine. Run it on yours before
  drawing conclusions.

## Layout

```
src/          the server, engines, k6 scripts, suite runner, UI, seed, config
src/databases/  one docker-compose.yml per engine, plus the per-engine notes
features.md          the original test spec
results/             run output (gitignored)
```

## License

MIT.
