# Benchmark suite

The write and read suite specified in [features.md](features.md): tests W1-W4
and R1-R10, three query shapes, three read modes, six limits, five concurrency
levels. It runs beside the transactional `like-tx` workload and never touches
its tables.

```bash
# quick end-to-end check (small dataset, 2 concurrency levels, 1s per cell)
node src/cli.ts --suite --profile smoke --db postgres

# the full matrix on one engine, or a slice of it
node src/cli.ts --suite --db postgres
node src/cli.ts --suite --db postgres,mysql --tests r1,r4,w3
```

## Everything is configurable

Every number in the spec lives in [bench.config.json](../bench.config.json).
The file is sparse: leave a key out and the default from
[src/suite/config.ts](../src/suite/config.ts) applies. Sizes may be written as
numbers or as `"100"`, `"1k"`, `"2M"`. The **fully-resolved** config is written
into every `result.json` under `config.suite`, so a run can be reproduced.

| Key | Default | Meaning |
| --- | --- | --- |
| `concurrency` | `1, 2, 8, 32, 64` | Every test runs at each level. |
| `limits` | `100, 1k, 3k, 5k, 10k, 20k` | Result sizes for R1-R4, R6, R8, R9, R10. |
| `shapes` | `simple, single-join, multi-join` | Which query shapes run. |
| `readModes` | `limit, offset, cursor` | Which read modes run. |
| `run.durationSec` / `warmupSec` / `repeats` | `3` / `1` / `1` | Per-cell timing for read tests. `repeats > 1` reports the median run. |
| `dataset.users` / `posts` / `likes` / `documents` | `100k` / `300k` / `1M` / `50k` | Seed data size. |
| `dataset.seed` | `42` | Every row is a pure function of (seed, id). |
| `dataset.tablePrefix` | `suite_` | Prefix for every suite table. |
| `guards.maxInFlightRows` | `5M` | Cells that would hold more rows in memory than this are **skipped and recorded**, never silently shrunk. |
| `writes.w1.rowsPerCell` | `20k` | Inserts per W1 cell. |
| `writes.w2.rowsPerCell` / `duplicateRatio` / `seedRows` | `20k` / `0.1` / `1000` | W2 size, share of inserts that collide on `email`, rows pre-seeded for them to collide with. |
| `writes.w3.batchSizes` | `1k, 10k, 30k, 50k, 100k` | Rows per batch. |
| `writes.w3.maxRowsPerCell` | `1M` | Total rows per W3 cell (at least one batch per worker). |
| `writes.w4.rowsPerCell` | `20k` | JSON document inserts per cell. |
| `reads.r3.scoreCutoff` | `500000` | R3/R7 predicate `score < cutoff` (about 50% of rows). |
| `reads.r4.maxPages` | `1000` | Cap on pages per traversal (see caveats). |
| `reads.r5.multiGetSizes` | `100, 1000` | Keys per `IN (...)` lookup. |
| `reads.r5.hotKey` | 80% of lookups hit 20% of keys | Optional skewed R5 variant. |
| `reads.r7.countRangeFraction` | `0.1` | Share of users matched by the indexed COUNT. |
| `reads.r8.fullSortRowCap` | `50k` | Rows in the capped full sort. |
| `reads.r9.fullText` | `true` | Include the full-text cells. |
| `reads.r10.docShape` | 4 fields, depth 2, array of 5 | JSON document shape. |
| `reports.r4Chart` | concurrency 1, page size 1k | Which R4 series the charts draw. |
| `reports.summaryConcurrency` | `8` | Concurrency shown in `summary.md`. |

**Profiles** (`--profile`) layer overrides on top: `smoke` (tiny, seconds per
cell), `standard` (the defaults), `full` (10s measured, 3s warmup, 3 repeats,
uncapped R4). Add your own under `profiles`. `--concurrency`, `--duration`,
`--warmup` and `--repeats` override the config when given.

The CLI prints the cell count and an estimated time before running. A `standard`
run is roughly 2 hours per engine; use `--tests` to run a slice.

## Data model

The suite has its own tables so its data never disturbs `like-tx`.

| Table | Columns | Notes |
| --- | --- | --- |
| `suite_users` | `id`, `email` (**unique**), `name`, `score`, `created_at`, `bio` | `created_at` is indexed after load. `score` is deliberately **never** indexed. |
| `suite_posts` | `id`, `user_id`, `title`, `views`, `created_at` | `user_id`, `created_at` indexed. |
| `suite_likes` | `id`, `post_id`, `user_id`, `created_at` | `post_id`, `user_id` indexed. |
| `suite_documents` | `id`, JSON `doc` | R10. Native `jsonb` / `JSON`; stored as the collection's own fields in MongoDB. |
| `suite_w_plain`, `suite_w_uk`, `suite_w_docs` | scratch tables | W1/W3, W2 (unique `email`), W4. Truncated before each cell. |

Query shapes: **simple** is `users`; **single-join** is `users JOIN posts`;
**multi-join** adds `JOIN likes`. Each shape orders and pages on the key of its
most numerous side (`u.id`, `p.id`, `l.id`), the only key unique per returned row.

**Planted blocks.** So that a search returns exactly the intended number of rows,
each limit `L` reserves a block of `L` consecutive ids. Users in block `L` are
named `pfx{L}-mid{L}-{id}-sfx{L}` and have `zq{L}` in `bio`; documents in block
`L` carry `k{L}`. `created_at` grows by one second per id, so a time range for
exactly `L` rows is computed rather than searched for.

## Tests

Every test runs at every concurrency level. "Rows" is recorded per query so the
returned size can be checked against the intended limit.

### Writes

| ID | What | Notes |
| --- | --- | --- |
| **W1** | Single inserts, non-transactional, no UK check | `rowsPerCell` inserts split across the workers. |
| **W2** | Same, but the unique key is enforced | `duplicateRatio` of inserts reuse a taken `email`. Those failures are counted as errors and, separately, as UK violations, and their latency is included. Cassandra enforces it with `IF NOT EXISTS`. |
| **W3** | Batch inserts | One batch per operation, sizes from `batchSizes`. Row generation is not timed. |
| **W4** | Raw document insert | JSON documents, one per insert. N/A where there is no document type. |

W1-W4 do a **fixed amount of work** and time the whole run, rather than running
for a duration.

### Core reads (R1-R4) and range reads (R6)

Each is run for **3 shapes x 3 modes x 6 limits**.

| ID | Filter |
| --- | --- |
| **R1** | none |
| **R2** | `email = ?` on the unique key, a fresh random email each time |
| **R3** | `score < cutoff`, a column with no index |
| **R4** | none; `limit` mode is R1's query, `offset` and `cursor` **walk the whole table page by page** |
| **R6** | `created_at BETWEEN a AND b`, with the range sized to match `limit` users |

Modes: `limit` is `LIMIT n`; `offset` is `LIMIT n OFFSET m` at a varying `m`;
`cursor` is keyset (`WHERE key > last LIMIT n`) from a varying start.

**R4 records the latency of every page** and writes it to
`charts/r4-<engine>-<shape>.svg` (offset vs cursor). Offset is expected to
degrade with depth and cursor to stay flat. With concurrency `c`, `c` workers
each walk the table; the plotted series is the median per page across workers.

### Extended reads (R5, R7-R10)

| ID | Cases |
| --- | --- |
| **R5** | Point lookup by PK for all three shapes, uniform keys; a hot-key variant (80/20); and multi-get `IN (...)` with 100 and 1k keys. No limit or paging. |
| **R7** | `COUNT(*)` whole table; `COUNT(*)` on an indexed column; on a non-indexed column; `SUM(views)`; posts per user (single join); likes per post; likes per user (multi join). |
| **R8** | Top-N on an indexed (`created_at`) vs non-indexed (`score`) sort key, 3 shapes x 6 limits; plus a full sort with no limit over a capped slice. |
| **R9** | Prefix, contains and suffix `LIKE` without an index; prefix again **with** a supporting index; full-text with its index. |
| **R10** | JSON filter on a top-level field, a nested field, and array-contains, each without and with an index. Index build time and size are recorded. |

For R9 and R10 the no-index cells run first; the runner then builds each index
once, measures with it, and drops it before the next.

## Engine coverage

Anything an engine cannot do honestly is recorded as `N/A` **with its reason**
rather than faked or left blank.

| | Postgres | CockroachDB | MySQL | SQL Server | MongoDB | Cassandra | Elasticsearch |
| --- | --- | --- | --- | --- | --- | --- | --- |
| W1, W3 | yes | yes | yes | yes | yes | yes | yes |
| W2 (UK check) | unique index | unique index | unique index | unique index | unique index | `IF NOT EXISTS` (LWT) | `_id = email`, `op_type: create` |
| W4, R10 (JSON) | `jsonb` + GIN | `jsonb` + inverted | `JSON` + functional / multi-valued idx | N/A (2022 has no JSON type) | native | N/A | native, always indexed (no unindexed variant) |
| Joins (R1-R8 shapes) | yes | yes | yes | yes | `$lookup` | N/A | N/A (no joins) |
| Offset paging | yes | yes | yes | yes | `skip` | N/A | yes (`max_result_window` raised) |
| R2, R3, R6 | yes | yes | yes | yes | yes | limit mode only (SAI / `ALLOW FILTERING`) | yes, but every field is indexed so R3 has no unindexed-scan contrast |
| R4 | yes | yes | yes | yes | yes | limit + cursor, simple only | limit, offset and cursor, simple only |
| R5 | yes | yes | yes | yes | yes | simple only | simple only |
| R7 | all 7 | all 7 | all 7 | all 7 | all 7 | first 4 (no joins) | all 7 (`posts-per-user`/`likes-per-post`/`likes-per-user` are `terms` aggs, no join needed) |
| R8 sort / top-N | yes | yes | yes | yes | yes | N/A (no ORDER BY on non-clustering column) | yes |
| R9 prefix / contains / suffix | yes | yes | yes | yes | regex | N/A | `wildcard` query, always indexed (no unindexed variant) |
| R9 full-text | `tsvector` + GIN | N/A (not driven yet) | `FULLTEXT` | N/A (component not in image) | text index | N/A | `match` query, always indexed (no unindexed variant) |

## What is recorded

Per cell and concurrency, in `result.json` under `engines[].suite.cells[]`:
status (`ok`, `na`, `skipped`, `error`) and reason; ops, wall time, **ops/sec and
rows/sec**; **rows per query**; latency **min, mean, p50, p95, p99, max**;
errors and unique-key violations; sample error messages. Also per engine: load
times, **index builds** (time and size), a **query plan for every distinct
query** (captured once, with a best-effort "index used" flag), and the R4
**per-page latency series** and total traversal times. Host, runtime and the
memory configuration are recorded as for every run.

## Output files

Under `results/<run-id>/`:

| File | Contents |
| --- | --- |
| `result.json` | Everything above, plus the resolved config. |
| `tables/<engine>.md` | One table per test ID, **concurrency as columns**, N/A reasons underneath. |
| `explain/<engine>.md` | The captured query plans. |
| `charts/r4-<engine>-<shape>.svg` | R4 per-page latency, offset vs cursor. |
| `summary.md` | The comparison across engines at one concurrency, best per row in bold. |

## Caveats

- **Closed-loop measurement.** Like the rest of the repo, results are comparative
  between engines, not absolute service levels.
- **R2 returns one row** (the unique key matches one user; joined shapes return
  that user's rows), so its `limit` does not change the result size. It is run
  as specified, and the rows column shows what came back.
- **R6 windows** match `limit` users, so paging a window of `limit` rows in
  `limit`-sized pages is a single page. On join shapes the row count is larger
  than `limit` because each user has several posts and likes.
- **R4 is capped** at `reads.r4.maxPages` pages per traversal. At page size 100
  over a million-row join, an uncapped offset walk is hours per worker. The
  `full` profile removes the cap.
- **W3 chunks large batches** into multi-row statements where a driver has a
  parameter limit (Postgres/CockroachDB 5,000 rows, MySQL 10,000 rows per
  statement). SQL Server uses its bulk API in one call. Cassandra runs
  bounded-concurrency single-row writes, since multi-partition `BATCH` is an
  anti-pattern there.
- **Memory.** `limit x concurrency` rows are held in flight; the guard exists
  because 20k x 64 is 1.3M rows and W3's 100k x 64 is 6.4M. Cells over the guard
  are skipped and recorded; raise `guards.maxInFlightRows` deliberately.
- **MongoDB joins use `$lookup`** and its sort uses `allowDiskUse`. That is the
  idiomatic way to express the query and its cost is part of the comparison.
- **MySQL's JSON index** is a functional (or multi-valued) index and only helps
  if the optimizer matches the query's expression; the captured plan shows
  whether it did.

## Answers to features.md section 10

Defaults chosen; each is a config key above.

- **Which non-indexed column?** `users.score`, for R3, R7 and R8.
- **Cursor key?** `id` of the shape's most numerous side.
- **Seed size?** 100k users, 300k posts, 1M likes, 50k documents.
- **Iterations and warmup?** 3s measured and 1s warmup per read cell; writes are fixed-work.
- **20k at concurrency 64?** Allowed up to `guards.maxInFlightRows` (5M rows in flight).
- **JSON shape?** 4 extra top-level fields, nesting depth 2, array of 5.
- **Text data and terms?** Planted markers, one block per limit, so match counts are exact.
- **Which databases support JSON, documents, full-text?** See the coverage table.
