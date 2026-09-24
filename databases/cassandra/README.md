# Cassandra

```bash
docker compose up -d --wait        # takes a minute or more to become healthy
node ../../src/cli.ts --db cassandra
node ../../src/cli.ts --db cassandra --profile smoke
```

Driver: `cassandra-driver` (DataStax), pure JS. Image: `cassandra:5.0`. Port
**9042**, no authentication. The keyspace `benchmark` is created on connect.

## What the suite runs

| Runs | Notes |
| --- | --- |
| W1, W3 | Bounded-concurrency single-row writes. A multi-partition `BATCH` is the well-known anti-pattern and trips batch size limits. |
| W2 | The unique key is `email` as a primary key, enforced with `INSERT .. IF NOT EXISTS` (LWT). Rejections are counted as UK violations. |
| R1, R4 | Simple shape; `limit` and cursor modes. Cursor paging uses `token(id)`, so page order is token order, not numeric id. |
| R2, R6 | Through Storage-Attached Indexes on `email` and `created_at`. `limit` mode only. |
| R3 | `score < ? ALLOW FILTERING`, a full scan on the deliberately unindexed column. `limit` mode only. |
| R5 | Key lookups and multi-get, simple shape. |
| R7 | The four single-table aggregations. |

Everything else is `N/A` with its reason: joins, `OFFSET`, sort / top-N (no
`ORDER BY` on a non-clustering column), text search (needs analyzed SAI indexes)
and JSON. The `likes` table is not created or loaded, since it only backs joins.

## Memory

Cassandra's `cassandra-env.sh` sizes the JVM heap from `/proc/meminfo`, i.e. the
**host's** RAM, not the container limit, so on a large host it picks a heap the
container cannot hold and the JVM is OOM-killed. `MAX_HEAP_SIZE` and
`HEAP_NEWSIZE` are therefore set explicitly (1G / 256M under a 4 GiB cap) and
must be set together. The heap is only part of the footprint: memtables, bloom
filters and index structures live off-heap, and the OS page cache does the read
caching.

## Notes

- The driver read timeout is raised to 120s: full-table `count(*)` and
  `ALLOW FILTERING` scans outlast the 12s default.
- `EXPLAIN` does not exist in CQL, so the results record the statement instead
  and `index used` is "unknown".
- Cassandra does not enforce a unique key in general; the dataset guarantees
  unique emails and W2 uses LWT.
