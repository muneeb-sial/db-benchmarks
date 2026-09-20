# PostgreSQL

```bash
docker compose up -d --wait
node ../../src/cli.ts --db postgres
```

Driver: `postgres` (porsager). This is the **reference adapter** — the one
driver with first-class support on Node and Bun, which makes it the
cross-runtime smoke target in CI.

[`adapter.ts`](adapter.ts) is parameterized (`PgFamilyOptions`) so any engine
speaking the Postgres wire protocol can reuse it. CockroachDB already does;
YugabyteDB would too.

## Memory

`shared_buffers` defaults to a **hardcoded 128MB** and does not read the cgroup
limit, so a 4 GiB container changes nothing on its own. `effective_cache_size`
defaults to 4GB — a planner lie about OS page cache that does not exist under a
4g cap. Both are set explicitly in the compose file and must move with
`DB_MEM_LIMIT`.

```bash
docker exec bench-postgres-postgres-1 \
  psql -U postgres -d benchmark -c 'show shared_buffers'
```

## Contention behaviour

At Postgres' default `READ COMMITTED`, the counter update serializes on the row
lock and re-evaluates (EvalPlanQual), so **no client retry is needed** — retry
counts here are normally zero, unlike CockroachDB. `40P01` (deadlock) only
appears if lock order varies, which is why every adapter in this repo updates
`posts` before inserting into `likes`.

Expect throughput to hold up under hot contention while p99 latency climbs:
requests queue on the lock rather than aborting.

## Notes

- `COUNT(*)` returns `bigint`, which postgres.js surfaces as a **string**. The
  adapter wraps it in `Number()`; the old harness published raw `'18910'` values
  into its results table.
- The data directory is intentionally unmounted, so `docker compose down`
  resets cleanly. Do not make it a tmpfs — tmpfs pages count against
  `mem_limit` and would eat the `shared_buffers` budget.
