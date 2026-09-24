# SQL Server

```bash
docker compose up -d --wait
node ../../src/cli.ts --db mssql
node ../../src/cli.ts --db mssql --profile smoke
```

Driver: `mssql` (which wraps `tedious`), pure JS. Image: `mssql/server:2022-latest`,
Developer edition. Port **1433**, user `sa`.

## What it does and doesn't run

Everything in the suite, **except**:

- **JSON (W4, R10)**: SQL Server 2022 has no native JSON type. Marked `N/A`.
- **Full-text (R9)**: the image ships without the full-text component. Marked `N/A`.

## Fairness notes

- **`READ_COMMITTED_SNAPSHOT` is ON.** SQL Server's default `READ COMMITTED` takes
  shared locks, so readers block writers, whereas Postgres and MySQL use row
  versioning. Leaving it off would make the comparison structurally unfair. The
  adapter enables it on connect and records it in the memory configuration.
- **Memory is 50%, not 25%.** SQL Server refuses to start below about 2 GB, and
  `max server memory` bounds nearly all its caches, so it cannot be squeezed to
  the 25% the other engines get. It defaults to 2048 MB under the 4 GiB cap. The
  value is recorded in every result file.

## Notes

- The container uses a self-signed certificate, so the adapter connects with
  `encrypt: false` and `trustServerCertificate: true`. This is a local fixture.
- Bulk loads and W3 batches use the driver's bulk API in a single call.
- `OFFSET .. FETCH` requires an `ORDER BY`; every suite query has one.
- The password (`Benchmark_Pass1`) meets SQL Server's complexity rules and is
  hardcoded because the database is a throwaway.
