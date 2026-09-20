# How to run

Copy-paste recipes for running the benchmark. Every command runs from the repo
root unless it says otherwise. For what the numbers mean, see the
[README](README.md).

## 0. Prerequisites

- **Node ≥ 22.18.0** or **Bun ≥ 1.2.21** (Deno is not supported)
- **Docker** with Compose v2

```bash
npm ci
```

## 1. Smoke test (about 1 minute)

Proves everything works end to end before you commit to a long run.

```bash
# start Postgres (each database has its own compose file)
docker compose -f databases/postgres/docker-compose.yml up -d --wait

# tiny run: 1 concurrency level, 1 repeat, small dataset
node src/cli.ts --db postgres --workload like-tx --contention uniform \
  --concurrency 8 --duration 3 --warmup 1 --repeats 1 \
  --users 1000 --posts-per-user 2
```

Expect `integrity: OK — 0/2000 posts mismatched` at the end. Results are written
to `results/<run-id>/result.json` and `result.md`.

Same thing on Bun:

```bash
bun src/cli.ts --db postgres --workload like-tx --concurrency 8 --duration 3 --repeats 1 --users 1000
```

## 2. Full benchmark, one database (about 5 minutes)

```bash
docker compose -f databases/postgres/docker-compose.yml up -d --wait

node src/cli.ts --db postgres --workload like-tx \
  --contention uniform,hot --concurrency 1,8,32,64 \
  --duration 10 --warmup 3 --repeats 3 \
  --users 20000 --posts-per-user 2

docker compose -f databases/postgres/docker-compose.yml down -v
```

That is the default configuration, so this is equivalent to
`node src/cli.ts --db postgres`.

## 3. Full benchmark, every database (about 30-40 minutes)

Run one database at a time so they don't compete for RAM, then compare. The
results of each run land in their own `results/<run-id>/` folder. Cassandra
skips `like-tx` and reports why; SQL Server runs everything.

**bash / Git Bash:**

```bash
for db in postgres mysql mongodb cockroachdb mssql cassandra; do
  docker compose -f databases/$db/docker-compose.yml up -d --wait
  node src/cli.ts --db $db --workload like-tx --contention uniform,hot \
    --concurrency 1,8,32,64 --duration 10 --warmup 3 --repeats 3
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

**PowerShell:**

```powershell
foreach ($db in "postgres","mysql","mongodb","cockroachdb","mssql","cassandra") {
  docker compose -f "databases/$db/docker-compose.yml" up -d --wait
  node src/cli.ts --db $db --workload like-tx --contention uniform,hot `
    --concurrency 1,8,32,64 --duration 10 --warmup 3 --repeats 3
  docker compose -f "databases/$db/docker-compose.yml" down -v
}
```

Running several in a single invocation (`--db postgres,mysql,mongodb`) also
works, but then all of those containers are up at once, each holding its own
4 GiB.

## 4. The write/read suite

Full detail is in [docs/suite.md](docs/suite.md). Every number (limits,
concurrency, batch sizes, dataset size, ...) is in
[bench.config.json](bench.config.json); edit it, or use a profile.

```bash
# quick check: small dataset, concurrency 1 and 8, one second per cell
node src/cli.ts --suite --profile smoke --db postgres

# one slice of the matrix
node src/cli.ts --suite --db postgres --tests r1,r4          # no-filter reads + full traversal
node src/cli.ts --suite --db postgres --tests writes         # W1-W4
node src/cli.ts --suite --db postgres --tests r9,r10         # text search and JSON

# the whole matrix, several engines, a custom config
node src/cli.ts --suite --db postgres,mysql,mongodb --config my.config.json

# the slow, careful profile: 10s measured + 3s warmup, 3 repeats, uncapped R4
node src/cli.ts --suite --profile full --db postgres
```

The CLI prints the cell count and a time estimate before it starts. Results go
to `results/<run-id>/`: `tables/<engine>.md` (one table per test, concurrency as
columns), `explain/<engine>.md`, `charts/r4-*.svg`, and `summary.md`.

## 5. Read workloads (original harness)

```bash
node src/cli.ts --db postgres \
  --workload point-lookup,age-range,list-posts,top-posts \
  --concurrency 1,8,32 --duration 10 --repeats 3 --limit 1000
```

| Workload | Measures |
| --- | --- |
| `like-tx` | insert a like + increment `like_count`, atomically |
| `point-lookup` | indexed lookup of a user by email |
| `age-range` | range count over an unindexed-by-default column |
| `list-posts` | bounded scan returning whole rows (`--limit` rows) |
| `top-posts` | sort by `like_count` |

Mix them in one run: `--workload like-tx,point-lookup,top-posts`.

## 6. Change the memory limit

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
```

Change it back the same way, for example `DB_MEM_LIMIT=2g …`, or put the values
in a `.env` file beside the compose file. Confirm the cap took effect:

```bash
docker inspect -f '{{.HostConfig.Memory}}' bench-postgres-postgres-1
```

## 7. Publish results into the README

```bash
node scripts/render-results.ts
```

This renders the newest `results/<run-id>/result.json` between the
`<!-- start -->` and `<!-- end -->` markers in `README.md`.

## 8. Stop everything

```bash
for db in postgres mysql mongodb cockroachdb mssql cassandra; do
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

`-v` discards the data so the next run starts clean.

## Useful flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--db` | all six | comma list: `postgres,mysql,mongodb,cockroachdb,mssql,cassandra` |
| `--suite` | off | run the write/read suite (see section 4) |
| `--tests` | `all` | suite only: `w1..w4`, `r1..r10`, `writes`, `reads` |
| `--profile` | none | suite only: `smoke`, `standard`, `full` |
| `--config` | `bench.config.json` | suite only: config file |
| `--workload` | `like-tx` | see the table above |
| `--contention` | `uniform,hot` | `like-tx` only |
| `--concurrency` | `1,8,32,64` | in-flight operations per cell |
| `--duration` | `10` | measured seconds per cell |
| `--warmup` | `3` | discarded seconds per cell |
| `--repeats` | `3` | repetitions per cell; the median is reported |
| `--users` | `20000` | users to generate |
| `--posts-per-user` | `2` | posts per user |
| `--seed` | `42` | dataset seed; keep it fixed to compare runs |
| `--out` | `results` | output directory |
| `--host` / `--port` | per engine | override the connection |

`node src/cli.ts --help` prints the full list.

**Run time** is roughly
`contention modes × concurrency levels × repeats × (duration + warmup)` seconds
per database, plus dataset load.

## Exit codes and troubleshooting

| Exit code | Meaning |
| --- | --- |
| `0` | Finished, every integrity check passed |
| `1` | Bad argument, unsupported runtime (Deno), or other startup failure |
| `2` | **Integrity failure**: a stored `like_count` disagreed with the actual likes, so the throughput numbers are not valid |

- **`MongoDB is running standalone, not as a replica set`**: start MongoDB from
  `databases/mongodb/docker-compose.yml`. A plain `mongod` has no multi-document
  transactions, and the harness refuses to benchmark it.
- **`<engine>: skipped`**: the engine couldn't connect or the driver isn't
  supported on your runtime. The rest of the run continues; the reason is printed
  and recorded in the result file.
- **Connection refused**: the container isn't healthy yet. Use `up -d --wait`,
  or check `docker compose -f databases/<db>/docker-compose.yml ps`.
- **Port already in use**: something else is on 5432 / 3306 / 27017 / 26257 /
  1433 / 9042. Stop it, or override with `--port`.
- **Suite cells show `N/A` or `skipped`**: that is deliberate, not a failure. The
  reason is printed and recorded (for example Cassandra has no joins, or a cell
  would exceed `guards.maxInFlightRows`).
- **Cassandra takes over a minute to become healthy**; SQL Server takes about 30
  seconds. `up -d --wait` handles both.
