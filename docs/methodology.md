# Methodology

Most database comparisons insert some rows, time a few `SELECT`s, and publish a
table. That mostly measures the driver and whatever cache the container
happened to get. This one is built around three ideas:

**1. Correctness is part of the result.** After the like workload, every
engine's stored `like_count` is compared against an actual count of that post's
likes. An engine whose transaction quietly didn't hold — MongoDB pointed at a
standalone node, a missed CockroachDB retry — fails this check, and the
benchmark exits non-zero. *A database that is fast because it didn't do the
work does not win.*

**2. Contention is the interesting axis.** Every transactional workload runs
twice: `uniform`, where likes spread across every post, and `hot`, where they
concentrate on ten. The gap between them is where engines genuinely diverge —
row-lock queueing, optimistic-retry storms, write conflicts. Retries are
reported as a metric, because a contention benchmark that hides them is
meaningless.

**3. The memory budget is stated, and equalized.** See [memory.md](memory.md).

## Caveats

- **Closed loop.** Exactly N workers each run operations sequentially until a
  deadline, rather than `Promise.all` over thousands of rows — which measures
  pool saturation, not latency. The trade-off is that a closed loop understates
  latency under overload (*coordinated omission*), so these numbers are
  **comparative between engines, not absolute service levels**.
- Warmup samples are discarded; each cell repeats and reports the median.
- **MongoDB runs as a single-node replica set**, which is mandatory for
  multi-document transactions. That also means `w:majority` is satisfied by one
  node, so it pays no replication cost here. Recorded in every result file.
- **MySQL is pinned to `READ-COMMITTED`** to match Postgres' default. At its own
  default of `REPEATABLE READ`, the insert into `likes` takes gap locks and the
  comparison would be measuring isolation level rather than engine.
- Benchmarks are **not** run in CI. Shared runners are noisy neighbours; CI only
  typechecks and smoke-tests both runtimes. Numbers come from local runs on
  known hardware.
- Results below were produced on one machine. Run it on yours before drawing
  conclusions.
