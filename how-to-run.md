# How to run

Copy-paste recipes. Every command runs from the repo root. For what the numbers
mean, see the [README](README.md); for every test in the suite, see
[docs/suite.md](docs/suite.md).

- [Setup](#setup)
- [Two things you can run](#two-things-you-can-run)
- [Common scenarios](#common-scenarios)
- [Running all the read tests](#running-all-the-read-tests)
- [Editing the config](#editing-the-config)
- [Reading the results](#reading-the-results)
- [Memory limits](#memory-limits)
- [Flags](#flags)
- [Troubleshooting](#troubleshooting)

## Setup

Needs **Node ≥ 22.18.0** (or **Bun ≥ 1.2.21**) and **Docker** with Compose v2.
Deno is not supported.

```bash
npm ci
```

Each database has its own compose file. Start one, run against it, stop it:

```bash
docker compose -f databases/postgres/docker-compose.yml up -d --wait
node src/cli.ts --suite --profile smoke --db postgres
docker compose -f databases/postgres/docker-compose.yml down -v
```

Databases: `postgres`, `mysql`, `mongodb`, `cockroachdb`, `mssql`, `cassandra`,
`elasticsearch`. Run **one at a time**; each container is capped at 4 GiB. Only
Postgres has been verified against the suite so far.

## Two things you can run

| | What it is | Turn it on with |
| --- | --- | --- |
| **The suite** | Writes W1-W4 and reads R1-R10 across query shapes, read modes, limits and concurrency levels. Configured in [bench.config.json](bench.config.json). | `--suite` |
| **The like workload** | The original transactional benchmark: insert a like and bump a counter atomically, with a correctness check. | `--workload like-tx` (the default when `--suite` is absent) |

They are independent. `--suite` alone skips like-tx; add `--workload like-tx` to
run both.

## Common scenarios

Each is a single command, so it works in bash and PowerShell alike. The times
are for one engine.

### Check that everything works (about 5 minutes)

```bash
node src/cli.ts --suite --profile smoke --db postgres
```

Small dataset, concurrency 1 and 8, limits 100 and 1k, one second per cell. Every
test runs, just smaller. Expect `suite: N ok` at the end and no errors.

### Run only the writes (a few minutes)

```bash
node src/cli.ts --suite --db postgres --tests writes
```

W1-W4: single inserts, inserts with the unique-key check, batch inserts, JSON
inserts. Pick one with `--tests w3`.

### Run all the read tests

See [the next section](#running-all-the-read-tests).

### See offset vs cursor pagination

```bash
node src/cli.ts --suite --db postgres --tests r4
```

R4 walks the whole table page by page. Open `results/<run>/charts/r4-postgres-simple.svg`
in a browser: offset latency climbs with page depth, cursor stays flat.

### Does an index help? (indexed vs not)

```bash
node src/cli.ts --suite --db postgres --tests r9,r10
```

R9 (text search) and R10 (JSON) each run without an index first, then build one
and run again. The results record index build time and size.

### Compare engines on the same tests

```bash
docker compose -f databases/postgres/docker-compose.yml up -d --wait
node src/cli.ts --suite --profile smoke --db postgres --tests r1,r5,w1
docker compose -f databases/postgres/docker-compose.yml down -v

docker compose -f databases/mysql/docker-compose.yml up -d --wait
node src/cli.ts --suite --profile smoke --db mysql --tests r1,r5,w1
docker compose -f databases/mysql/docker-compose.yml down -v
```

Each run writes its own `results/<run>/`, with its own `summary.md`. To get **one**
`summary.md` comparing engines, run them in a single command instead. The
containers are then all up at once:

```bash
node src/cli.ts --suite --profile smoke --db postgres,mysql --tests r1,r5,w1
```

### The most careful run (slow)

```bash
node src/cli.ts --suite --profile full --db postgres
```

10 seconds measured plus 3 warmup per cell, 3 repeats with the median reported,
and R4 uncapped. This is many hours; narrow it with `--tests`.

### The like workload

```bash
# quick
node src/cli.ts --db postgres --workload like-tx --contention uniform --concurrency 8 --duration 3 --warmup 1 --repeats 1 --users 1000

# full defaults (about 5 minutes): uniform + hot contention, concurrency 1,8,32,64
node src/cli.ts --db postgres --workload like-tx
```

Expect `integrity: OK` at the end. The original small read workloads
(`point-lookup`, `age-range`, `list-posts`, `top-posts`) are separate:
`--workload point-lookup,age-range,list-posts,top-posts`.

### On Bun instead of Node

```bash
bun src/cli.ts --suite --profile smoke --db postgres
```

### Run several engines one after another

**bash / Git Bash:**

```bash
for db in postgres mysql mongodb cockroachdb mssql cassandra elasticsearch; do
  docker compose -f databases/$db/docker-compose.yml up -d --wait
  node src/cli.ts --suite --profile smoke --db $db
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

**PowerShell:**

```powershell
foreach ($db in "postgres","mysql","mongodb","cockroachdb","mssql","cassandra","elasticsearch") {
  docker compose -f "databases/$db/docker-compose.yml" up -d --wait
  node src/cli.ts --suite --profile smoke --db $db
  docker compose -f "databases/$db/docker-compose.yml" down -v
}
```

### Reproduce a run

The dataset is a pure function of `dataset.seed` (default 42), so the same seed
gives identical data on every engine and every run. The fully-resolved config is
saved in `result.json` under `config.suite`; copy it to a file and pass it with
`--config` to repeat a run exactly.

## Running all the read tests

`--tests reads` runs R1 through R10 and skips the writes:

```bash
node src/cli.ts --suite --db postgres --tests reads
```

That is the whole read matrix: **391 cells x 5 concurrency levels = 1,955 runs**.
The CLI prints the cell count and an estimate before it starts. With the default
config the timed runs alone are about **2 hours** per engine
(1,775 timed runs x (3s + 1s warmup)), and more once you add the R4 traversals,
data loading and index builds. Ctrl+C stops it.

| Test | What it reads |
| --- | --- |
| R1 | no filter |
| R2 | `WHERE` on the unique key |
| R3 | `WHERE` on a non-indexed column |
| R4 | full table traversal, page by page, per-page latency |
| R5 | point lookup by primary key, plus multi-get |
| R6 | range on an indexed column |
| R7 | aggregations: `COUNT`, `SUM`, `GROUP BY` |
| R8 | sorting and top-N, indexed vs non-indexed |
| R9 | text search: prefix, contains, suffix, full-text |
| R10 | JSON / document queries, indexed vs not |

R1-R4 and R6 are each 3 shapes x 3 modes x 6 limits, which is where most of the
time goes.

### Make it shorter

Pick whichever fits. They combine.

| To do this | Use | Effect |
| --- | --- | --- |
| Quick version of everything | `--profile smoke` | about 5 minutes |
| Shorter cells | `--duration 1 --warmup 0` | about 30 minutes for all reads |
| Fewer concurrency levels | `--concurrency 1,8,32` | 40% fewer runs |
| Only some tests | `--tests r1,r2,r3` | just those |
| Skip the join queries | `"shapes": ["simple"]` in the config | about 2/3 fewer cells. Posts and likes are then loaded only if R7 is included, because its aggregations always join. |
| Fewer result sizes | `"limits": ["100", "1k"]` in the config | fewer cells |
| Fewer read modes | `"readModes": ["limit", "cursor"]` in the config | fewer cells |

Steady numbers and short runs pull against each other: 1-second cells are
noisier than 3 seconds plus a warmup. Use short runs to check things work, and
longer ones for the numbers you keep.

Some cases are `N/A` by design (for example Cassandra has no joins, SQL Server
has no JSON type). That is not a failure; the reason is recorded next to each.

### Slices of the read tests

```bash
node src/cli.ts --suite --db postgres --tests r1,r2,r3,r4     # core matrix
node src/cli.ts --suite --db postgres --tests r5,r6           # lookups and ranges
node src/cli.ts --suite --db postgres --tests r7,r8           # aggregations and sorting
node src/cli.ts --suite --db postgres --tests r9,r10          # text search and JSON
```

## Editing the config

Every number in the suite is in [bench.config.json](bench.config.json). No code
changes are needed.

**How it is layered**, later beats earlier:

1. built-in defaults (in `src/suite/config.ts`)
2. `bench.config.json`
3. the `--profile` you named (`smoke`, `standard`, `full`, or your own)
4. the flags `--concurrency`, `--duration`, `--warmup`, `--repeats`

So the file can be **sparse**: leave a key out and its default applies. JSON has
no comments. Sizes can be numbers or strings such as `"100"`, `"1k"`, `"2M"`.

### Two ways to change it

**Edit the file** for a change you want every time. Open `bench.config.json`,
change the value, run.

**Use a separate file** for a one-off. Write only the keys you want to change:

```json
{
  "concurrency": [1, 8],
  "limits": ["100", "1k"],
  "shapes": ["simple"]
}
```

Save it as, say, `my.config.json`, and run:

```bash
node src/cli.ts --suite --db postgres --tests reads --config my.config.json
```

Check that it took effect: the CLI prints a `suite:` line at the start with the
concurrency, limits and dataset it is really using. The full resolved config is
also written into `result.json`.

### Common edits

| I want to... | Set |
| --- | --- |
| Different concurrency levels | `"concurrency": [1, 4, 16]` |
| Different result sizes | `"limits": ["500", "2k", "10k"]` |
| Skip join queries | `"shapes": ["simple"]` |
| Skip offset pagination | `"readModes": ["limit", "cursor"]` |
| Longer, steadier cells | `"run": { "durationSec": 10, "warmupSec": 3, "repeats": 3 }` |
| Smaller dataset (faster load) | `"dataset": { "users": "20k", "posts": "60k", "likes": "200k", "documents": "10k" }` (also lower `limits`, see below) |
| Different batch sizes | `"writes": { "w3": { "batchSizes": ["500", "5k", "20k"] } }` |
| More duplicate emails in W2 | `"writes": { "w2": { "duplicateRatio": 0.3 } }` |
| Allow bigger cells (memory permitting) | `"guards": { "maxInFlightRows": "10M" }` |
| Turn off the hot-key lookup | `"reads": { "r5": { "hotKey": { "enabled": false } } }` |
| Different multi-get sizes | `"reads": { "r5": { "multiGetSizes": [50, 500] } }` |
| Skip full-text search | `"reads": { "r9": { "fullText": false } }` |
| Different JSON document shape | `"reads": { "r10": { "docShape": { "topLevelFields": 8, "nestedDepth": 3, "arraySize": 10 } } }` |
| Let R4 walk every page | `"reads": { "r4": { "maxPages": 1000000 } }` |
| Change the random data | `"dataset": { "seed": 7 }` |

Nested keys merge, so you only write the leaf you are changing.

### Rules the config enforces

The run stops immediately, with a message, if a value is invalid. The one to
remember: **the dataset must be big enough for the limits.** Text search and JSON
tests plant one block of matching rows per limit, so `dataset.users` and
`dataset.documents` must each be at least the **sum of the limits** (39,100 for
the defaults). If you add a `"50k"` limit, raise `dataset.documents` above the
new sum (and `dataset.users` if needed).

### Make your own profile

Add one under `profiles` in `bench.config.json`:

```json
"profiles": {
  "reads-quick": {
    "concurrency": [1, 8, 32],
    "run": { "durationSec": 2, "warmupSec": 1 },
    "shapes": ["simple", "single-join"]
  }
}
```

```bash
node src/cli.ts --suite --profile reads-quick --db postgres --tests reads
```

## Reading the results

Each run creates `results/<timestamp>/`:

| File | What is in it |
| --- | --- |
| `summary.md` | Engines side by side at one concurrency. The best per row is bold. |
| `tables/<engine>.md` | One table per test, concurrency as columns, with N/A reasons underneath. |
| `explain/<engine>.md` | The query plan for every distinct query, with a best-effort "index used" flag. |
| `charts/r4-<engine>-<shape>.svg` | R4 per-page latency, offset vs cursor. Open in a browser. |
| `result.json` | All the raw numbers plus the resolved config. |
| `result.md` | The original like-workload report. |

Each cell shows ops/sec, p95 latency and the rows returned per query. Check that
rows match the limit you intended.

**Reading the "index used" flag.** It is true for *any* index scan. A query that
filters on an unindexed column but returns rows in primary-key order (R3) can show
true, because the primary-key index supplies the ordering. Read the plan itself
before trusting it.

To render the newest run into the README's results block:

```bash
node scripts/render-results.ts
```

## Memory limits

The default is 4 GiB per database. Move the limit **and** the engine cache
together; they are separate settings (see the README's "memory trap").

```bash
# Postgres: 8 GiB
cd databases/postgres
DB_MEM_LIMIT=8g PG_SHARED_BUFFERS=2GB PG_EFFECTIVE_CACHE=6GB docker compose up -d --wait

# MySQL: 8 GiB
cd databases/mysql
DB_MEM_LIMIT=8g MYSQL_BUFFER_POOL=2G docker compose up -d --wait

# MongoDB: 8 GiB
cd databases/mongodb
DB_MEM_LIMIT=8g MONGO_CACHE_GB=2 docker compose up -d --wait

# CockroachDB: 8 GiB (cache is a fraction, so it tracks automatically)
cd databases/cockroachdb
DB_MEM_LIMIT=8g docker compose up -d --wait

# SQL Server: 8 GiB (needs about 2 GB minimum, so 4g is the practical floor)
cd databases/mssql
DB_MEM_LIMIT=8g MSSQL_MEMORY_MB=4096 docker compose up -d --wait

# Cassandra: 8 GiB (set the JVM heap explicitly; it sizes itself from HOST RAM)
cd databases/cassandra
DB_MEM_LIMIT=8g CASSANDRA_HEAP=2G CASSANDRA_HEAP_NEW=512M docker compose up -d --wait

# Elasticsearch: 8 GiB (single JVM, so the heap is ~50% of the limit, Xms == Xmx)
cd databases/elasticsearch
DB_MEM_LIMIT=8g ES_JAVA_OPTS="-Xms4g -Xmx4g" docker compose up -d --wait
```

Change it back the same way (for example `DB_MEM_LIMIT=2g ...`), or put the values
in a `.env` file beside the compose file. In PowerShell set the variables first
(`$env:DB_MEM_LIMIT = "8g"`) then run `docker compose up -d --wait`. Confirm the
cap took effect:

```bash
docker inspect -f '{{.HostConfig.Memory}}' bench-postgres-postgres-1
```

## Stop everything

```bash
for db in postgres mysql mongodb cockroachdb mssql cassandra elasticsearch; do
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

`-v` discards the data so the next run starts clean.

## Flags

`node src/cli.ts --help` prints the full list.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--db` | all seven | comma list: `postgres,mysql,mongodb,cockroachdb,mssql,cassandra,elasticsearch` |
| `--out` | `results` | output directory |
| `--host` / `--port` | per engine | override the connection |
| **Suite** | | |
| `--suite` | off | run the write/read suite |
| `--tests` | `all` | `w1..w4`, `r1..r10`, `writes`, `reads`, `all` |
| `--profile` | none | `smoke`, `standard`, `full`, or your own |
| `--config` | `bench.config.json` | config file |
| **Both** | | |
| `--concurrency` | suite: config; like-tx: `1,8,32,64` | in-flight operations per cell. Overrides the config. |
| `--duration` | suite: config; like-tx: `10` | measured seconds per cell |
| `--warmup` | suite: config; like-tx: `3` | discarded seconds per cell |
| `--repeats` | suite: config; like-tx: `3` | repetitions per cell; the median is reported |
| **Like workload only** | | |
| `--workload` | `like-tx` | `like-tx`, `point-lookup`, `age-range`, `list-posts`, `top-posts` |
| `--contention` | `uniform,hot` | `like-tx` only |
| `--users` | `20000` | users to generate |
| `--posts-per-user` | `2` | posts per user |
| `--seed` | `42` | dataset seed |

`--users`, `--posts-per-user` and `--seed` do not affect the suite; its dataset
size and seed come from the config.

## Troubleshooting

| Exit code | Meaning |
| --- | --- |
| `0` | Finished; every integrity check passed |
| `1` | Bad argument or config, unsupported runtime (Deno), or a startup failure |
| `2` | **Integrity failure** in the like workload: a stored `like_count` disagreed with the actual likes, so those numbers are not valid |

- **A config error, such as `dataset.documents must be at least the sum of the
  limits`**: the message names the key and the rule. See
  [Rules the config enforces](#rules-the-config-enforces).
- **`unknown test "x"`**: `--tests` takes `w1..w4`, `r1..r10`, `writes`, `reads`
  or `all`.
- **Suite cells show `N/A` or `skipped`**: deliberate, not a failure. The reason
  is printed and recorded (for example Cassandra has no joins, or a cell would
  exceed `guards.maxInFlightRows`).
- **`MongoDB is running standalone, not as a replica set`**: start MongoDB from
  `databases/mongodb/docker-compose.yml`. A plain `mongod` has no multi-document
  transactions, and the harness refuses to benchmark it.
- **`<engine>: skipped`**: the engine couldn't connect, or its driver isn't
  supported on your runtime. The rest of the run continues; the reason is printed
  and recorded.
- **Connection refused**: the container isn't healthy yet. Use `up -d --wait`, or
  check `docker compose -f databases/<db>/docker-compose.yml ps`. Cassandra takes
  over a minute to become healthy, SQL Server about 30 seconds.
- **Port already in use**: something else is on 5432, 3306, 27017, 26257, 1433,
  9042 or 9200. Stop it, or override with `--port`.
- **Out of memory, or the run is very slow**: lower `concurrency`, `limits` or
  `dataset` sizes, or raise the container memory limit.
