# Layout

```
src/core/       adapter contract, closed-loop runner, stats, retry, reporting
src/dataset/    seeded user/post generation (like-tx)
src/workloads/  like-tx (with contention modes) and read workloads
src/suite/      the write/read suite: config, data, test matrix, runner, reports
src/sql/        SQL dialects and the query builder shared by the SQL engines
databases/      one folder per engine: adapter.ts + docker-compose.yml (+ suite.ts)
databases/_template/   how to add an engine
bench.config.json      every number the suite uses
docs/suite.md          the suite: each test, its configuration and results
results/        <run-id>/result.json, result.md, and the suite's tables/charts
```

Adding a database means copying `databases/_template/` and adding one line to
`src/core/registry.ts`. See that folder's README for the checklist.
