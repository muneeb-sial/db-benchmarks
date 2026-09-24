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

## Notes

- `COUNT(*)` returns `bigint`, which postgres.js surfaces as a **string**. The
  adapter wraps it in `Number()`; the old harness published raw `'18910'` values
  into its results table.
- The data directory is intentionally unmounted, so `docker compose down`
  resets cleanly. Do not make it a tmpfs — tmpfs pages count against
  `mem_limit` and would eat the `shared_buffers` budget.
