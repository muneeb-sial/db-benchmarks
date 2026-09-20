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

## 3. Full benchmark, all four databases (about 20-25 minutes)

Run one database at a time so they don't compete for RAM, then compare. The
results of each run land in their own `results/<run-id>/` folder.

**bash / Git Bash:**

```bash
for db in postgres mysql mongodb cockroachdb; do
  docker compose -f databases/$db/docker-compose.yml up -d --wait
  node src/cli.ts --db $db --workload like-tx --contention uniform,hot \
    --concurrency 1,8,32,64 --duration 10 --warmup 3 --repeats 3
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

**PowerShell:**

```powershell
foreach ($db in "postgres","mysql","mongodb","cockroachdb") {
  docker compose -f "databases/$db/docker-compose.yml" up -d --wait
  node src/cli.ts --db $db --workload like-tx --contention uniform,hot `
    --concurrency 1,8,32,64 --duration 10 --warmup 3 --repeats 3
  docker compose -f "databases/$db/docker-compose.yml" down -v
}
```

Running all four in a single invocation (`--db postgres,mysql,mongodb,cockroachdb`)
also works, but then all four containers are up at once, each holding its own
4 GiB.

## 4. Read workloads

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

## 5. Change the memory limit

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
```

Change it back the same way, for example `DB_MEM_LIMIT=2g …`, or put the values
in a `.env` file beside the compose file. Confirm the cap took effect:

```bash
docker inspect -f '{{.HostConfig.Memory}}' bench-postgres-postgres-1
```

## 6. Publish results into the README

```bash
node scripts/render-results.ts
```

This renders the newest `results/<run-id>/result.json` between the
`<!-- start -->` and `<!-- end -->` markers in `README.md`.

## 7. Stop everything

```bash
for db in postgres mysql mongodb cockroachdb; do
  docker compose -f databases/$db/docker-compose.yml down -v
done
```

`-v` discards the data so the next run starts clean.

## Useful flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--db` | all four | comma list: `postgres,mysql,mongodb,cockroachdb` |
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
- **Port already in use**: something else is on 5432 / 3306 / 27017 / 26257.
  Stop it, or override with `--port`.
