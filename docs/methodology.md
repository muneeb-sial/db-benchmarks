# Methodology

Most database comparisons insert some rows, time a few `SELECT`s, and publish a
table. That mostly measures the driver and whatever cache the container
happened to get. This one is built around two ideas:

**1. The memory budget is stated, and equalized.** See [memory.md](memory.md).

## Caveats

- **Closed loop.** Exactly N workers each run operations sequentially until a
  deadline, rather than `Promise.all` over thousands of rows — which measures
  pool saturation, not latency. The trade-off is that a closed loop understates
  latency under overload (*coordinated omission*), so these numbers are
  **comparative between engines, not absolute service levels**.
- Warmup samples are discarded; each cell repeats and reports the median.
- **MongoDB runs as a single-node replica set**, so `w:majority` is satisfied
  by one node and it pays no replication cost here. Recorded in every result
  file.
- Benchmarks are **not** run in CI. Shared runners are noisy neighbours; CI only
  typechecks and smoke-tests both runtimes. Numbers come from local runs on
  known hardware.
- Results below were produced on one machine. Run it on yours before drawing
  conclusions.
