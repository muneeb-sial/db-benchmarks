# Layout

```
src/core/       adapter contract, engine registry, stats, reporting
src/suite/      the write/read suite: config, data, test matrix, runner, reports
src/types/      every interface and type alias, one <module>.type.ts per module
src/sql/        SQL dialects and the query builder shared by the SQL engines
databases/      one folder per engine: adapter.ts + docker-compose.yml (+ suite.ts, impl.ts, plans.ts for non-SQL engines)
src/sql/impl.ts  per-test ReadImpl/WriteImpl shared by every SQL engine; src/suite/with-impl.ts wires any impl into a suite
databases/_template/   how to add an engine
bench.config.json      every number the suite uses
docs/suite.md          the suite: each test, its configuration and results
results/        <run-id>/result.json, result.md, and the suite's tables/charts
```

Adding a database means copying `databases/_template/` and adding one line to
`src/core/registry.ts`. See that folder's README for the checklist.
