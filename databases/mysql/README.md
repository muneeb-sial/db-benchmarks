# MySQL

```bash
docker compose up -d --wait
node ../../src/cli.ts --db mysql
```

Driver: `mysql2`, not the `mariadb` connector the original repo used. Both are
pure JS, but `mysql2` is the one Bun explicitly fixed `node:tls`/`node:net`
support for in 1.2.21, and this repo has always actually tested against
`mysql:8` rather than MariaDB. Verified on Node and Bun.

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
