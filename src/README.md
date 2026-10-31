# Bench server (Bun + k6)

- **The server** ([index.ts](index.ts)) is a Bun HTTP API. Each request runs
  exactly one database operation.
- **k6** owns concurrency and timing.
- **Seed data** is generated once into [seed/](seed/readme.md) and loaded into
  each database by `POST /:db/initialize`.
- **The databases** run from the compose files in [databases/](databases/README.md).
  That README also has the memory and fairness notes per engine.

Everything the benchmark needs is in this folder, including its config,
[config/bench.config.json](config/bench.config.json). Only run output goes
outside it, to `<repo>/results/`. From the repo root, the npm-style scripts
are `bun run seed`, `bun run server`, `bun run bench` and `bun run typecheck`.

## Run it

Requires Bun 1.2.3+, [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/),
and Docker with Compose v2.

```bash
# 1. seed files (once per profile)
bun src/seed/generate.ts --profile smoke

# 2. the server, with the same profile as the seed (Docker must be running;
#    initialize creates each database's container itself)
BENCH_PROFILE=smoke bun src/index.ts            # PowerShell: $env:BENCH_PROFILE='smoke'

# 3a. a suite from the terminal (the same run as the page's Suite tab)
bun src/suite/cli.ts --db postgres --dry-run                       # plan + estimate only
bun src/suite/cli.ts --db postgres,mysql --tests r1,r2,w3
bun src/suite/cli.ts --db postgres --tests r1 --concurrency 1,8 --limits 100 --shapes simple --duration 5

# 3b. or one cell by hand
curl -X POST localhost:3000/postgres/initialize
k6 run -e DB=postgres -e VUS=32 -e SHAPE=single-join -e MODE=cursor -e LIMIT=100 src/k6/r1.js
```

A suite run writes to `results/<run-id>/`:
- `summary.md` and `outcomes.json`
- `run.json` (the request and the resolved config)
- one k6 summary JSON per cell and concurrency level

`suite/cli.ts` (`bun run bench`) flags: `--db`, `--tests`, `--concurrency`, `--limits`, `--shapes`,
`--modes`, `--duration`, `--warmup`, `--verbose` (raw k6 output),
`--skip-init` (use the already-loaded databases), `--dry-run`, `--base-url`.
Ctrl+C stops the run, and the server kills the k6 process in flight.

## Suites

A suite is many tests × databases × concurrency levels in one run.
`POST /api/suite` streams it as NDJSON events (`plan`, `db-start`,
`db-ready`, `cell-start`, `cell-result`, `cell-na`, `cell-failed`, `k6`,
`done`). [suite/events.ts](suite/events.ts) turns each event into one log line.
The page and the terminal client (`suite/cli.ts`) share it, so both print the same thing:

```
[ 57/568] r1 single-join cursor 100 @ 32 VUs
          → 4,210 req/s · http p50 6.1 / p95 11.8 ms · db p50 3.4 ms / p95 7.2 ms · rows 100
  N/A r1 multi-join offset 100: Cassandra has no joins
```

How the request body is resolved:

- **Overrides** use the same shape as `bench.config.json` and are merged over
  the server's profile for that run only.
  - Per-run keys: `concurrency`, `limits`, `shapes`, `readModes`, `run`,
    `writes`, `reads.r4` and `reads.r5`.
  - `dataset` comes from the seed, and `reads.r3`, `r7`, `r8` and `r10` are
    read by the server itself. Overriding them is rejected with 400, because
    the change wouldn't take effect.
  - In the Suite tab, the Advanced box starts pre-filled with the current
    values, and only applies when "Apply these overrides" is ticked.
- **R9/R10** run only at limits the seed planted.
- **Search indexes stay** (see [Indexes](#indexes)). A no-index R9/R10 cell
  drops the one index its query would use, just for that cell, and the
  runner rebuilds it before the "+index" cells. Cells are ordered so this
  happens once per index. When the run ends, even after Stop or a failure,
  every index the database had before is back.
- **One suite at a time.** A second request gets 409, and closing the request
  stops the run.

Building blocks:
- [suite/matrix.ts](suite/matrix.ts) builds the cells.
- [suite/run.ts](suite/run.ts) runs them.
- [databases/state.ts](databases/state.ts) holds initialize, which a single click and the suite share.

## Runner UI

Open **http://localhost:3000/** with the server running. The page
([ui/index.html](ui/index.html) + [ui/app.ts](ui/app.ts)) is a Bun HTML import,
bundled on the fly and styled with the Tailwind browser CDN. On it you can:

- pick a database, see whether it's initialized, and **Reinitialize** it: the
  container is recreated (all data deleted), then the seed is loaded from scratch
- pick a test and its query params. The exact request is previewed, and N/A
  combinations are flagged from `/:db/coverage` before you send anything
- **Execute once** to see the status, rows, server-side DB time, browser round
  trip, the JSON response, and a history of recent runs
- **Run k6** with VUs, duration and warmup. The server spawns k6 against
  itself (`POST /api/k6`) and streams the output live; **Stop** kills the run
- build or drop R9/R10 indexes, truncate scratch tables, and verify `like_count`
- **Suite tab:** tick several databases and tests, and set the matrix
  (concurrency levels, limits, shapes, read modes, duration, warmup).
  Everything is pre-filled from `bench.config.json`, and an advanced box takes
  raw JSON overrides. A live estimate shows the run count and time.
  **Run suite** streams every step into the Response window, with a progress
  bar, a filterable results table and a `summary.md` link at the end. Your
  choices are kept in this browser's localStorage; the config file is never
  written.

The UI has its own `tsconfig` for DOM types: `bunx tsc -p src/ui`.

## API

| Method | Route | What |
| --- | --- | --- |
| GET | `/api/status` | liveness, profile, database names |
| GET | `/api/config` | resolved `bench.config.json`, profile names, tests, databases |
| POST | `/api/suite/plan` | dry run of a suite request: cells, N/A, run count, estimate |
| POST | `/api/suite` | run a suite; NDJSON events streamed (see [Suites](#suites)) |
| GET | `/api/runs/:id/summary` | a finished run's `summary.md` |
| POST | `/:db/initialize` | fresh start: `docker compose down -v` then `up -d --wait` in `src/databases/<db>/` (old container and all data gone), then create the schema, stream the seed in, build baseline indexes, then every search index the engine supports (`?indexes=none` skips those). **424** if the seed is missing or doesn't match the config; **503** with the compose output if docker fails |
| GET | `/:db/status` | initialized?, load time per table, manifest |
| GET | `/:db/coverage` | every op with `ok` or its N/A reason (no DB connection needed) |
| GET | `/:db/read/:test` | `r1`..`r10`; params below |
| POST | `/:db/write/:test` | `w1`..`w4`; `?id=` or `?start=&size=` |
| POST | `/:db/like?post=&user=` | one like transaction |
| GET | `/:db/verify` | `like_count` integrity check (422 on drift) |
| POST / DELETE | `/:db/index/:kind` | build / drop `name-prefix`, `fulltext`, `json-top`, `json-nested`, `json-array` |
| POST | `/:db/reset/:table` | truncate `w_plain`, `w_uk`, `w_docs`, or `tx_likes` (also zeroes `like_count`) |

Status codes: **400** bad params, **409** unique-key hit (expected in W2),
**412** not initialized, **424** seed missing, **501** N/A on this engine.

Every op returns `{ rows, last?, dbMs }` and a `Server-Timing: db;dur=<ms>`
header. `dbMs` covers the engine call only; parsing and row building happen
before the timer starts. k6 records it as the `db_ms` trend next to its own
`http_req_duration`.

Read params (see [Tests](#tests)):

| Test | Params |
| --- | --- |
| r1, r3, r4 | `shape` (simple / single-join / multi-join), `mode` (limit / offset / cursor), `limit`, `offset` or `after` |
| r2 | the above + `email` |
| r5 | `kind=id&shape=&id=`, or `kind=multi&size=&slot=` |
| r6 | the r1 params; the range matches `limit` users (`count=` overrides) |
| r7 | `variant` = count-all, count-indexed, count-unindexed, sum-views, posts-per-user, likes-per-post, likes-per-user |
| r8 | `kind=topn&shape=&key=indexed\|unindexed&limit=`, or `kind=fullsort` |
| r9 | `kind=like&pattern=prefix\|contains\|suffix&limit=`, or `kind=fulltext&limit=` (limit must be a planted limit) |
| r10 | `variant=top-level\|nested\|array-contains&limit=` |

## Tests

The spec is [features.md](../../features.md). The data model:
- **users:** `id`, unique `email`, `name`, `score` (never indexed), `created_at`, `bio`
- **posts:** `id`, `user_id`, `title`, `views`, `like_count`, `created_at`
- **likes:** `id`, `post_id`, `user_id`, `created_at`
- **documents:** one JSON `doc` per row
- **scratch tables** for writes: `w_plain`, `w_uk` (unique `email`), `w_docs`,
  and `tx_likes` for like-tx

Query **shapes**:
- **simple** is `users`
- **single-join** is `users ⋈ posts`
- **multi-join** adds `⋈ likes`

Each shape orders and pages on the key of its most numerous side (`u.id`,
`p.id`, `l.id`).

Read **modes**:
- `limit` is `LIMIT n`
- `offset` is `LIMIT n OFFSET m`
- `cursor` is keyset paging: `WHERE key > last LIMIT n`

| ID | What |
| --- | --- |
| **W1** | Single inserts, no unique key. Fixed work: `rowsPerCell` inserts split across the VUs. |
| **W2** | Single inserts with the unique key enforced. `duplicateRatio` of them reuse an existing `email`; those hit 409 and count as UK violations, with their latency kept. |
| **W3** | Batch inserts, one batch per request, one cell per `batchSizes` entry. |
| **W4** | Raw JSON document inserts. |
| **R1** | No filter. |
| **R2** | `email = ?` on the unique key, a fresh random user each request. |
| **R3** | `score < cutoff` on a column with no index (about 50% of rows). |
| **R4** | Walks the whole table page by page (offset vs cursor); every request is tagged with its page. |
| **R5** | Point lookup by primary key: uniform, hot-key (80/20), and multi-get `IN (...)`. |
| **R6** | `created_at BETWEEN a AND b`, with the range sized to `limit` users. |
| **R7** | `COUNT(*)` (whole table, indexed range, unindexed filter), `SUM(views)`, posts per user, likes per post, likes per user. |
| **R8** | Top-N on an indexed (`created_at`) vs unindexed (`score`) key, plus a full sort over a capped slice. |
| **R9** | Prefix / contains / suffix `LIKE` without an index, prefix with one, and full-text. |
| **R10** | JSON filter on a top-level field, a nested field, and array membership, each without and with an index. |
| **like** | Transaction: `posts.like_count += 1`, then insert into `tx_likes`, under uniform and hot contention; `/verify` checks no count drifted. |

**Planted blocks.** For each configured limit `L`, a block of `L` consecutive
ids carries marker text (see [seed/](seed/readme.md)). A search for `L`'s
marker therefore returns exactly `L` rows, so R9 and R10 return the intended
size.

**Caveats:**
- **Closed loop.** k6's `constant-vus` is closed-loop, so the numbers compare
  engines rather than describe service levels.
- **R2** matches one user, so its `limit` doesn't change the result size.
- **R6** on joined shapes returns more than `limit` rows, because each user
  has several posts.
- **R4** is capped at `reads.r4.maxPages` pages per walk.
- **MongoDB joins** are `$lookup` with `allowDiskUse`; that cost is part of
  the comparison.

## Layout

```
index.ts      routes (the server's entry point)
config/       config.ts (loader + env/connections), bench.config.json (every number, plus profiles)
http/         errors.ts, response.ts (json / Server-Timing), params.ts, ops.ts (request → one engine call)
engine/       the Engine contract and shared types
engines/      one class per database, registry.ts (name → engine)
databases/    a docker-compose.yml per engine, docker.ts (recreate), state.ts (initialize + index state)
seed/         generate, manifest, load, rows
suite/        matrix, run, events, cli.ts (terminal client for /api/suite)
k6/           one script per test + lib.js, path.ts (find k6), runner.ts (POST /api/k6)
ui/           the runner page
```

## One class per engine, no shared queries

[engine/engine.ts](engine/engine.ts) declares one method per operation:
`r1Scan`, `r2FindByEmail`, `r3FilterUnindexedScore`, `r5GetById`,
`r5MultiGet`, `r6CreatedAtRange`, `r7Aggregate`, `r8TopN`, `r8FullSort`,
`r9Like`, `r9FullText`, `r10Json`, `w1Insert`, `w2InsertUnique`,
`w3InsertBatch`, `w4InsertDoc`, `likeTx`, `verifyLikeCounts`.

Each class in [engines/](engines/) writes its own SQL, CQL, aggregation
pipeline or Query DSL for every shape × mode. Postgres and MySQL do not share a
single statement, and there is no query builder. To add an engine, subclass
`Engine`, implement every method, answer `support()` with N/A reasons, and add
one line to [engines/registry.ts](engines/registry.ts).

## Engine coverage

N/A cells are reported with their reason, never faked. The exact matrix is
`GET /:db/coverage`.

| | Postgres | CockroachDB | MySQL | SQL Server | MongoDB | Cassandra | Elasticsearch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1, W3 | yes | yes | yes | yes (bulk API) | yes | yes | yes (`_bulk`) |
| W2 unique key | unique index | unique index | unique index | unique index | unique index | `IF NOT EXISTS` | `_create`, `_id` = email |
| W4, R10 JSON | `jsonb` + GIN / expression | `jsonb` + inverted | `JSON` + functional / multi-valued | N/A | native | N/A | native (keyword fields) |
| Joins (non-simple shapes) | yes | yes | yes | yes | `$lookup` | N/A | N/A |
| Offset paging | yes | yes | yes | yes | `skip` | N/A | `from/size` up to 10k |
| Cursor paging | yes | yes | yes | yes | `_id > after` | `token(id)` | `search_after` |
| R2, R3, R6 | yes | yes | yes | yes | yes | simple, limit mode only | simple |
| R5 | yes | yes | yes | yes | yes | simple | simple (`_doc` / `_mget`) |
| R7 | all 7 | all 7 | all 7 | all 7 | all 7 | first 4 | first 4 |
| R8 top-N / full sort | yes | yes | yes | yes | yes | N/A | simple |
| R9 LIKE | yes | yes | yes | yes | regex | N/A | `prefix` / `wildcard` |
| R9 full-text | `tsvector` + GIN | N/A | `FULLTEXT` (index required) | N/A | text index | N/A | `match` |
| R9/R10 index build | yes | yes (no full-text) | yes | name only | yes | N/A | N/A (indexed at mapping) |
| like-tx | yes | yes (40001 retries) | yes | yes | yes (replica set) | N/A | N/A |

Notes:

- **MySQL full-text and MongoDB `$text` need their index.** Without it the
  query errors. Initialize builds it by default, and suites always run
  full-text with it present.
- **The like transaction** uses its own table `srv_tx_likes` (PK
  `user_id, post_id`), so it never collides with the seeded likes. `k6/like.js`
  resets it in `setup()` and fails the run in `teardown()` if any
  `like_count` drifted.
- **Elasticsearch** stores `score` as `index: false` + doc values, its nearest
  equivalent to "no index". Its R3 range runs off doc values.

## Indexes

Initialize builds, in this order:

1. **With the tables:** primary keys, unique `email` on `users` and `w_uk`, and
   PK `(user_id, post_id)` on `tx_likes`.
2. **After the seed load (baseline):** `users(created_at)`, `posts(user_id)`,
   `posts(created_at)`, `likes(post_id)`, `likes(user_id)`, then statistics.
3. **Search indexes (default on):** `name-prefix`, `fulltext`, `json-top`,
   `json-nested` and `json-array`, wherever the engine supports them:
   - Postgres, MySQL and MongoDB: all 5
   - CockroachDB: `name-prefix`, plus one inverted index on `doc` that serves
     all three JSON kinds
   - SQL Server: `name-prefix` only
   - Cassandra and Elasticsearch: none

   Each build time is in the initialize response and the suite log.
   `?indexes=none` (or `--no-indexes`, or unticking the box in the Suite tab)
   skips them.

`GET /:db/status` lists the search indexes that exist right now, and the page
shows them as badges. They stay until the container is recreated, or until you
drop one with `DELETE /:db/index/:kind` (Maintenance → Drop). `users.score` is
never indexed on purpose (R3, R7 and R8).

Running a k6 script by hand with `INDEX=<kind>` makes sure that index exists,
and drops it in teardown only if the script had to build it.

## Measuring

- **One k6 process per cell per concurrency level.** Each one gets a clean
  summary. `VUS` is the concurrency; nothing in the server limits it, apart
  from the per-engine pool (`POOL_SIZE`, default 64).
- **Timed reads:** a `WARMUP`-second scenario tagged `phase:warmup`, then
  `DURATION` seconds tagged `phase:measure`. Only the measure phase is
  reported.
- **Writes are fixed work.** `shared-iterations` with `ROWS` operations
  (W3: `MAX_ROWS / SIZE` batches, at least one per VU).
- **R4 walks the table.** Each VU walks it page by page (`per-vu-iterations`),
  and every request is tagged `page`. For per-page latency, run k6 with
  `--out json=r4.json`.
- **Coordinated omission.** k6's `constant-vus` is a closed loop, like the old
  runner, so treat the numbers as comparisons between engines, not service
  levels. For open-loop arrival rates, swap in k6's `constant-arrival-rate`
  executor.
