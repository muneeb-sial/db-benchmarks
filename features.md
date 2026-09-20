# Database Benchmark Suite: Feature Spec & Test Plan

## 1. Goal

Add a benchmark suite that measures **write** and **read** performance across the databases under evaluation. Every test, its configuration, and its results must be documented.

**Global rule:** every test below is executed at each of these concurrency levels:

| Concurrency levels |
|---|
| 1, 2, 8, 32, 64 |

---

## 2. Data Model (assumed)

| Table | Key fields | Notes |
|---|---|---|
| `users` | `id`, `email` (**unique key**), `name`, `created_at` (indexed), plus at least one **non-indexed** column | `email` is used for UK tests |
| `posts` | `id`, `user_id`, `created_at`, ... | belongs to a user |
| `likes` | `id`, `post_id`, `user_id`, ... | belongs to a post |

For the JSON tests (W4, R10), documents also carry a JSON/JSONB column (top-level fields, nested fields, and an array field).

## 3. Query Shapes (used by most read tests)

| Shape | Description |
|---|---|
| **Simple** | Single table (`users`) |
| **Single join** | `users` JOIN `posts` |
| **Multi join** | `users` JOIN `posts` JOIN `likes` |

## 4. Read Modes (used by R1 to R4 and R6)

Each of these read tests runs at these limits: **100, 1k, 3k, 5k, 10k, 20k**.

| Mode | Description |
|---|---|
| **Simple limit** | `LIMIT n`, no pagination |
| **Offset pagination** | `LIMIT n OFFSET m` |
| **Cursor pagination** | Keyset / cursor based (`WHERE id > last_id LIMIT n`) |

---

## 5. Write Tests

### W1. Single inserts, non-transactional, no UK check
- High volume of individual inserts, no transaction wrapper.
- Simple test; no unique-key validation involved.

### W2. Single inserts, non-transactional, with UK check
- Same as W1, but the insert must enforce and check the unique key (`email`).

### W3. Batch inserts, non-transactional
- Batch sizes: **1k, 10k, 30k, 50k, 100k** rows per batch (long batches).

### W4. Raw document insert (JSONB vs MongoDB)
- For every RDBMS that supports **JSONB**, run a JSONB insert test **alongside MongoDB** to measure raw data insert performance.
- If a database does **not** support a document type, it does not take part in this test (mark as **N/A**).

---

## 6. Read Tests

### Core matrix: R1 to R4

Each of R1 to R4 is run for **all 3 query shapes × 3 read modes × 6 limits**.

| ID | Filter | Purpose |
|---|---|---|
| **R1** | No filter | Baseline read performance |
| **R2** | `WHERE` on the unique key (e.g. user `email`) | Indexed lookup |
| **R3** | `WHERE` on any **non-indexed** column | Full scan behavior |
| **R4** | No filter, **full table traversal** | Walk the entire table page by page |

#### R1. No filter
- Simple limit, offset pagination, cursor pagination.
- Limits: 100, 1k, 3k, 5k, 10k, 20k.

#### R2. `WHERE` on unique key
- Same matrix as R1, with a `WHERE email = ...` clause.

#### R3. `WHERE` on non-indexed value
- Same matrix as R1, with a `WHERE` on a column that has no index.

#### R4. Full table traversal
- **Simple limit:** same as R1.
- **Offset pagination:** run until the end of the table, traversing every page, and **record latency for each page**.
- **Cursor pagination:** run until the end of the table, traversing every page, and **record latency for each page**.
- Purpose: show how latency changes as the traversal goes deeper (offset is expected to degrade; cursor is expected to stay flat).

### Extended matrix: R5 to R10

| ID | Test | Purpose |
|---|---|---|
| **R5** | Point lookup by PK | The simplest and most common query |
| **R6** | Range query on an indexed column | Index range scan behavior |
| **R7** | Aggregations | `COUNT`, `SUM`, `GROUP BY` cost |
| **R8** | Sorting and top-N | Sort cost, indexed vs non-indexed |
| **R9** | Text search | Prefix, contains, and full-text search |
| **R10** | JSON / document queries | Filtering and indexing inside JSON |

#### R5. Point lookup by primary key
- Fetch one record by PK, random keys (uniform distribution). Optionally repeat with a hot-key distribution (e.g. 80% of lookups hit 20% of keys).
- **Shapes:** simple, single join (user + their posts), multi join (user + posts + likes).
- **Multi-get variant:** `WHERE id IN (...)` with **100** and **1k** keys, simple shape only.
- No limit or pagination modes apply.

#### R6. Range query on an indexed column
- Filter on `created_at BETWEEN a AND b` (indexed column).
- Choose the range width so each query matches roughly **100, 1k, 3k, 5k, 10k, 20k** rows.
- **Matrix:** 3 shapes × 3 read modes × 6 result sizes.
- Optional comparison: the same range on a non-indexed column.

#### R7. Aggregations

| Query | Shape |
|---|---|
| `COUNT(*)` on the whole table | Simple |
| `COUNT(*)` with `WHERE` on an indexed column | Simple |
| `COUNT(*)` with `WHERE` on a non-indexed column | Simple |
| `SUM(...)` over a numeric column | Simple |
| `GROUP BY user_id`: posts per user | Single join |
| `GROUP BY post_id`: likes per post | Posts + likes |
| `GROUP BY user_id`: likes per user | Multi join |

#### R8. Sorting and top-N
- **Sort key:** indexed column vs non-indexed column.
- **Top-N:** `ORDER BY ... LIMIT n` with n = 100, 1k, 3k, 5k, 10k, 20k.
- **Matrix:** 2 sort keys × 3 shapes × 6 limits.
- **Full sort (no limit):** 2 sort keys × 3 shapes, run on a capped dataset so it stays practical.

#### R9. Text search

| Pattern | Notes |
|---|---|
| Prefix: `LIKE 'abc%'` | Can use a normal index |
| Contains: `LIKE '%abc%'` | Usually a full scan |
| Suffix: `LIKE '%abc'` | Usually a full scan |
| Full-text search | Only for databases that support it (tsvector, FULLTEXT, text index, etc.); otherwise **N/A** |

- Simple shape, limits 100, 1k, 3k, 5k, 10k, 20k.
- Test with and without a supporting index where relevant.

#### R10. JSON / document queries
- Only for databases with JSON/JSONB or document support (compare against MongoDB). Others are **N/A**.
- **Filter types:** top-level field, nested field, array contains.
- **Index state:** without an index vs with an index (e.g. GIN / expression index / MongoDB index).
- **Limits:** 100, 1k, 3k, 5k, 10k, 20k.
- **Matrix:** 3 filter types × 2 index states × 6 limits.
- Also record **index build time** and **index size**.

---

## 7. Test Matrix Summary

| Group | Configurations | × Concurrency (5) |
|---|---|---|
| W1 + W2 (single inserts) | 2 | 10 runs |
| W3 (batch inserts) | 5 | 25 runs |
| W4 (JSONB vs MongoDB) | per supporting DB | 5 runs per DB |
| R1 to R4 (core reads) | 4 × (3 shapes × 3 modes × 6 limits) = 216 | 1,080 runs |
| R5 (point lookup) | 3 shapes + 2 multi-get = 5 | 25 runs |
| R6 (range query) | 3 × 3 × 6 = 54 | 270 runs |
| R7 (aggregations) | 7 | 35 runs |
| R8 (sorting / top-N) | 2 × 3 × 6 + 2 × 3 = 42 | 210 runs |
| R9 (text search) | 4 patterns × 6 limits = 24 | 120 runs |
| R10 (JSON queries) | 3 × 2 × 6 = 36 | 180 runs |
| **Total (excluding W4)** | **391** | **1,955 runs** |

R9 full-text and R10 only apply to databases that support them. Everything above is repeated for each database under test.

---

## 8. What to Record

**For every run**
- Database, version, config, hardware
- Test ID, query shape, read mode, limit / batch size, concurrency
- Dataset size and warm-up / iteration count
- Rows returned per query (to confirm the result size matches the intended limit)
- Query plan (`EXPLAIN` or equivalent) for each distinct query, to confirm whether an index was actually used

**Metrics**
- Latency: min, avg, p50, p95, p99, max
- Throughput: ops/sec and rows/sec
- Error count / error rate (including UK violations in W2)
- Optional: CPU and memory usage

**Extra for R4**
- Per-page latency series (page number vs latency) for both offset and cursor traversal
- Total traversal time

**Extra for R10**
- Index build time and index size

---

## 9. Output Format

- One results table per test ID, per database, with concurrency as columns.
- Per-page latency charts for R4 (offset vs cursor, per database).
- A final comparison summary across databases.

---

## 10. Open Questions

- Which databases are in scope, and which support JSONB, documents, and full-text search?
- What is the seed dataset size (rows in users, posts, likes)?
- Which non-indexed column is used for R3, R6 (optional), and R8?
- What is the cursor key (`id` or another column)?
- How many iterations and how much warm-up per test?
- Is a 20k limit at concurrency 64 acceptable for memory, or do we need a cap?
- What shape should the JSON documents have (fields, nesting depth, array size)?
- What text data and search terms are used for R9, so match counts are controlled?