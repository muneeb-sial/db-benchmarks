# Databases

This folder holds the database lifecycle:
- **One folder per engine**, each with the `docker-compose.yml` that
  `POST /:db/initialize` recreates the database from (`docker compose down -v`,
  then `up -d --wait`).
- **[docker.ts](docker.ts)** runs that recreate.
- **[state.ts](state.ts)** does the rest of initialize: schema, seed load,
  baseline and search indexes. It also tracks which databases are ready and
  which search indexes exist.

The engine classes live in [../engines/](../engines/).

| Engine | Folder | Port | Image |
| --- | --- | --- | --- |
| PostgreSQL | [postgres/](postgres/docker-compose.yml) | 5432 | `postgres:16.3` |
| MySQL | [mysql/](mysql/docker-compose.yml) | 3306 | `mysql:8` |
| MongoDB | [mongodb/](mongodb/docker-compose.yml) | 27017 | single-node replica set `rs0` |
| CockroachDB | [cockroachdb/](cockroachdb/docker-compose.yml) | 26257 (admin UI 8080) | single node |
| SQL Server | [mssql/](mssql/docker-compose.yml) | 1433 | `mssql/server:2022-latest`, Developer |
| Cassandra | [cassandra/](cassandra/docker-compose.yml) | 9042 | `cassandra:5.0` |
| Elasticsearch | [elasticsearch/](elasticsearch/docker-compose.yml) | 9200 | `elasticsearch:8.15.3`, security off |

Connection settings are in [../config/config.ts](../config/config.ts) (`CONNECTIONS`), and each
can be overridden by env (`PG_HOST`, `PG_PORT`, `MONGO_URL`, `ES_URL`, …).

## Memory: the cap alone is not fair

Every compose file defaults to a **4 GiB** limit (`DB_MEM_LIMIT`), with
`memswap_limit` equal to it (otherwise Docker grants the same again in swap).
A cap is not enough on its own, because the engines disagree on where their
cache size comes from:

| Engine | Default cache | Reads the cgroup limit? | Set here |
| --- | --- | --- | --- |
| PostgreSQL | `shared_buffers` 128MB, hardcoded | no | `PG_SHARED_BUFFERS` (1GB), `PG_EFFECTIVE_CACHE` (3GB) |
| MySQL | `innodb_buffer_pool_size` 128MB, hardcoded | no | `MYSQL_BUFFER_POOL`, about 25% of the limit |
| MongoDB | `max(50% of (RAM − 1GB), 256MB)` | **yes** (~1.5GB under 4g) | `--wiredTigerCacheSizeGB`, explicit |
| CockroachDB | 128MB | the fraction form is | `--cache=.25`, which tracks the limit by itself |
| SQL Server | most of RAM | no | `MSSQL_MEMORY_MB`, 50%: it refuses to start below about 2GB |
| Cassandra | JVM heap from the **host's** RAM | no | `MAX_HEAP_SIZE` / `HEAP_NEWSIZE` (1G / 256M), set together |
| Elasticsearch | heap from RAM | — | `ES_HEAP` (2g), at most 50% of the limit; the rest is page cache for Lucene |

Left alone, MongoDB would get a 12× bigger cache than Postgres and MySQL, and
the results would look like MongoDB being fast. So move each cache knob
**together with** `DB_MEM_LIMIT`, either on the command line or in a `.env`
next to the compose file (gitignored):

```bash
DB_MEM_LIMIT=8g PG_SHARED_BUFFERS=2GB PG_EFFECTIVE_CACHE=6GB docker compose up -d --wait
```

The server's initialize runs `docker compose` from the engine's folder, so a
`.env` there applies to it too. No data directory is mounted, so
`down -v` really does start from nothing. Don't make it a tmpfs: tmpfs pages
count against `mem_limit`.

## Engine notes that affect the results

**PostgreSQL**
- At `READ COMMITTED` the counter update waits on the row lock and
  re-evaluates, so like-tx needs no client retries. Expect p99 to climb under
  hot contention, not aborts.
- `COUNT(*)` is a `bigint`, which postgres.js returns as a string, so it's
  wrapped in `Number()`.

**MySQL**
- `--transaction-isolation=READ-COMMITTED` is pinned to match Postgres. At
  MySQL's default `REPEATABLE READ`, the like insert takes gap locks, and the
  comparison would be about isolation level rather than engine.
- Deadlocks (1213) and lock-wait timeouts (1205) are routine under contention,
  so they're retried and counted.
- `decimalNumbers: true` keeps `COUNT(*)` a number.
- The JSON indexes are functional or multi-valued indexes. They only help when
  the query repeats the indexed expression exactly, as the engine's queries do.

**MongoDB**
- Multi-document transactions need a replica set. A standalone `mongod`
  silently has none, so the compose file runs single-node `rs0`, and its
  healthcheck runs `rs.initiate()`.
- The client uses `directConnection=true`, because the hostname the set
  advertises is often unreachable from the host.
- On one node, `w: majority` costs no replication.
- Stay on driver **6.x**: 7.x fails to load on Bun.

**CockroachDB**
- It's `SERIALIZABLE` by default, and aborts conflicts with `40001` instead
  of blocking, so client retries are the normal path under contention. The
  retry count is the interesting number.
- `start-single-node` only creates `defaultdb`, so the engine creates
  `benchmark` itself.
- `server_version` reports 13.0.0 (its Postgres level), so `version()` is used.

**SQL Server**
- `READ_COMMITTED_SNAPSHOT` is switched on at connect, so readers don't block
  writers, matching the row versioning of Postgres and MySQL.
- No JSON type in 2022, and no full-text component in the image: both N/A.
- Self-signed certificate, so `encrypt: false` and `trustServerCertificate: true`
  (a local fixture). The password `Benchmark_Pass1` meets the complexity rules.

**Cassandra**
- No cross-partition transaction through 5.x. A logged `BATCH` isn't isolated,
  LWT is single-partition only, and counters double-count on retry. Accord
  arrives in 6 (pre-GA). So like-tx is N/A, rather than replaced with something
  weaker.
- Storage-Attached Indexes on `email` and `created_at`. `score` is scanned with
  `ALLOW FILTERING`.
- It takes a minute or more to become healthy. The read timeout is raised to
  120s for full scans.

**Elasticsearch**
- No joins and no transactions.
- Offset paging stops at `max_result_window` (10,000).
- `score` is `index: false` with doc values.
- Writes don't force a refresh; the load ends with one.

## Adding a database

1. Add `<engine>/docker-compose.yml` here. It needs a memory cap with
   `memswap_limit` equal to it, the engine's cache set explicitly from that cap,
   a real healthcheck, and no data volume.
2. Add `../engines/<engine>.ts`: a class extending `Engine`
   ([../engine/engine.ts](../engine/engine.ts)). Write every query by hand, for
   every shape and mode; nothing is shared with other engines. In `support()`,
   return an N/A reason for anything the engine can't do honestly.
3. Register it in [../engines/registry.ts](../engines/registry.ts) and add its
   connection to `CONNECTIONS` in [../config/config.ts](../config/config.ts).
4. Keep the lock order: like-tx updates `posts` **before** inserting into
   `tx_likes`, in every engine. `verifyLikeCounts()` must count real rows.
