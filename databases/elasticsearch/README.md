# Elasticsearch

```bash
docker compose up -d --wait
node ../../src/cli.ts --db elasticsearch
node ../../src/cli.ts --suite --db elasticsearch --profile smoke
```

Driver: `@elastic/elasticsearch` (official client), pure JS. Image:
`docker.elastic.co/elasticsearch/elasticsearch:8.15.3`, single node, security
disabled for local benchmarking. Port **9200**, no authentication.

## It does not run the like transaction

`like-tx` is **skipped**, with the reason recorded in the results. Elasticsearch
has no multi-document transaction primitive at all -- not even Cassandra's
weaker "atomic but not isolated" logged `BATCH`. A single document write is
atomic; the like and the post's counter, as two documents, never are together.
`transactionality` is `none`.

`top-posts`, unlike on Cassandra, **is** supported: sorting by `like_count`
is exactly what Elasticsearch's own index is fast at.

## What the suite runs

| Runs | Notes |
| --- | --- |
| W1-W4 | Single and bulk indexing. `w_uk`'s unique key is `email` used as the document `_id`, enforced with `op_type: create`; a 409 conflict is the UK violation. JSON (W4) is native. |
| R1, R4, R5 | Simple shape; `limit`, `offset` and cursor modes. Cursor paging filters `id > after`, the same non-`search_after` idiom the other non-join adapters use. |
| R2, R3, R6 | `term`/`range` queries on `email`, `score` and `created_at`. `score` is deliberately unindexed the way it is everywhere else, but Elasticsearch indexes every mapped field by default -- there is no separate "unindexed scan" to measure here, which the results note. |
| R7 | All four aggregations, including `posts-per-user`/`likes-per-post`/`likes-per-user`: `posts` and `likes` already carry their parent id directly, so these are plain `terms` aggregations, not a join. |
| R9 | Full support. Prefix/contains/suffix are `wildcard` queries on a `keyword` field; fulltext is a `match` query on an analyzed `text` field. |
| R10 | Full support. Documents are native JSON; `tag`/nested/`tags` filters are `term` queries against the keyword sub-field Elasticsearch's dynamic mapping creates automatically. |

Only relational shapes are `N/A`: `single-join` and `multi-join`, since
Elasticsearch has no joins.

## Memory

Elasticsearch is a single JVM, so unlike Cassandra (heap kept to ~25% of the
container limit, because memtables/bloom filters/page cache also compete) the
heap here is set to ~50% via `ES_JAVA_OPTS`, matching Elasticsearch's own
sizing guidance, with `Xms == Xmx` so the JVM never resizes mid-run. See
`docker-compose.yml` for the exact recipe.

## Notes

- `index.max_result_window` is raised at schema-creation time to cover the
  largest configured `limit`/`fullSortRowCap`, since Elasticsearch caps
  `from + size` at 10,000 by default and offset paging would otherwise fail
  honestly rather than silently.
- There is no runtime way to disable indexing on one field without a full
  reindex, so the suite's `createIndex`/`dropIndex` throw rather than fake a
  toggle.
- On native Linux Docker hosts, Elasticsearch requires
  `vm.max_map_count >= 262144` on the host; Docker Desktop (Windows/WSL2, macOS)
  usually satisfies this already. If the container exits immediately, check
  `docker compose logs` for a `max virtual memory areas` error and raise it
  with `sysctl -w vm.max_map_count=262144` on the host.
