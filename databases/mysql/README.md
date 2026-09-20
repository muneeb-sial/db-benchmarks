# MySQL

```bash
docker compose up -d --wait
node ../../src/cli.ts --db mysql
```

Driver: `mysql2`, not the `mariadb` connector the original repo used. Both are
pure JS, but `mysql2` is the one Bun explicitly fixed `node:tls`/`node:net`
support for in 1.2.21, and this repo has always actually tested against
`mysql:8` rather than MariaDB. Verified on Node and Bun.

## Isolation is pinned, on purpose

The compose file sets `--transaction-isolation=READ-COMMITTED`, overriding
MySQL's default of `REPEATABLE READ`.

This is a fairness decision, not a tuning one. At `REPEATABLE READ`, the insert
into `likes` takes **gap / next-key locks** on the unique index — a classic
deadlock source for exactly this insert-plus-update shape. Since Postgres
defaults to `READ COMMITTED`, leaving MySQL at its own default would mean
publishing an isolation-level difference as though it were a performance
difference.

## Retries are required

Unlike Postgres, MySQL needs client-side retry here:

- **1213** `ER_LOCK_DEADLOCK` — InnoDB detects a cycle and kills one
  transaction outright.
- **1205** `ER_LOCK_WAIT_TIMEOUT` — waited past `innodb_lock_wait_timeout`
  (default 50s).

Both are handled by the shared `withRetry` wrapper and counted in the results.

## Memory

`innodb_buffer_pool_size` defaults to a **hardcoded 128MB** and does not read
the cgroup limit. `innodb_dedicated_server=ON` *would* be cgroup-aware, but it
targets ~75% of detected memory, which is not what Postgres is given — for a
comparison, explicit beats automatic. Set via `MYSQL_BUFFER_POOL`, kept at
roughly 25% of `DB_MEM_LIMIT`.

```bash
docker exec bench-mysql-mysql-1 \
  mysql -uroot -proot -e "show variables like 'innodb_buffer_pool_size'"
```

## Notes

- `decimalNumbers: true` is set so `COUNT(*)` arrives as a number rather than a
  string.
- Bulk loads use `query` with a `VALUES ?` array rather than `execute`, since
  prepared statements do not accept the multi-row form.
