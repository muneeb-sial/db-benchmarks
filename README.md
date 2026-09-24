# db-benchmarks

Benchmarks for **PostgreSQL**, **MySQL**, **MongoDB**, **CockroachDB**,
**SQL Server**, **Cassandra** and **Elasticsearch**, written once in
TypeScript and runnable unmodified on **Node** and **Bun**. Deno is not
supported.

The write/read suite runs Writes W1-W4 and reads R1-R10 across three query
shapes, three read modes, six limits and five concurrency levels.

## Documentation

| Doc | What's in it |
| --- | --- |
| [how-to-run.md](docs/how-to-run.md) | Setup, copy-paste recipes, flags, troubleshooting |
| [docs/suite.md](docs/suite.md) | The write/read suite: each test, its configuration and results |
| [features.md](docs/features.md) | The suite's feature spec and test plan |
| [docs/methodology.md](docs/methodology.md) | What is measured and why, plus caveats |
| [docs/memory.md](docs/memory.md) | The memory trap and how limits are equalized |
| [docs/engines.md](docs/engines.md) | Per-engine notes: Cassandra, SQL Server, Elasticsearch |
| [docs/layout.md](docs/layout.md) | Repo layout and how to add a database |
| [bench.config.json](bench.config.json) | Every number the suite uses |
| [results/](results) | Run outputs and the archive of earlier results |

## Latest results

Regenerate with `node scripts/render-results.ts`.

<!-- start -->
<!-- end -->
