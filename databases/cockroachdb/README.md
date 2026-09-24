# CockroachDB

```bash
docker compose up -d --wait
node ../../src/cli.ts --db cockroachdb
```

Driver: `postgres` (porsager) — CockroachDB speaks the Postgres wire protocol,
so this adapter is a thin wrapper over
[`../postgres/adapter.ts`](../postgres/adapter.ts) and reuses its schema
unchanged. Verified on Node and Bun.

Runs on **port 26257**, not 5432, so it can run alongside Postgres.

## What actually differs from Postgres

CockroachDB defaults to `SERIALIZABLE` and *aborts* conflicting transactions
with `SQLSTATE 40001` rather than blocking on a row lock, the way Postgres does
at `READ COMMITTED`.

## Memory

Unlike the others, CockroachDB takes its cache as a *fraction*, and the
percentage form **is** cgroup-aware — so `--cache=.25` tracks `DB_MEM_LIMIT`
automatically with no second knob to keep in sync. The defaults (128MB) are far
too small to be representative.

## Other notes

- `start-single-node` comes up with only `defaultdb`, so the adapter creates the
  target database over a throwaway connection before connecting properly. The
  Postgres image does this for you via `POSTGRES_DB`; CockroachDB has no
  equivalent.
- `SHOW server_version` reports the Postgres compatibility level CockroachDB
  advertises (13.0.0), not its own version, so the adapter uses `version()`.
- Keep DDL vanilla: no triggers, no `LISTEN/NOTIFY`, no Postgres extensions.
- Worth exploring: v23.2+ supports `READ COMMITTED`
  (`sql.txn.read_committed_isolation.enabled`), which removes most 40001s and
  makes the comparison against Postgres and MySQL more direct.
- The admin UI is on <http://localhost:8080> — useful for diagnosing retry
  storms.
