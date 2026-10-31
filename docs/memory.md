# Memory

## The memory trap

Capping a container is not enough to make a fair comparison, because these
engines do not agree on where their cache size comes from:

| Engine | Default cache | Reads the cgroup limit? | Under a bare `mem_limit: 4g` |
| --- | --- | --- | --- |
| PostgreSQL | `shared_buffers` = 128MB, hardcoded | No | uses **128MB** |
| MySQL | `innodb_buffer_pool_size` = 128MB, hardcoded | No | uses **128MB** |
| MongoDB | `max(50% of (RAM − 1GB), 256MB)` | **Yes** | uses **~1.5GB** |

So a naive memory limit hands MongoDB a **12× larger cache** than the other
two, and the resulting table looks like MongoDB being fast. Every compose file
here therefore sets the engine's cache explicitly, derived from the same
`DB_MEM_LIMIT`, and every run records what it used.


## Memory limits

Each `databases/<engine>/docker-compose.yml` defaults to **4 GiB** and is
overridable without editing the file:

```bash
# up
DB_MEM_LIMIT=8g PG_SHARED_BUFFERS=2GB PG_EFFECTIVE_CACHE=6GB docker compose up -d

# down
DB_MEM_LIMIT=2g PG_SHARED_BUFFERS=512MB PG_EFFECTIVE_CACHE=1536MB docker compose up -d
```

…or drop a `.env` file next to the compose file. Each compose file documents
its own engine's knob at the top.

Two rules:

- **Move the cache knob with the limit.** Compose cannot do arithmetic, so the
  engine cache is a second variable. Keep it around 25% of `DB_MEM_LIMIT` so
  every engine gets the same working memory. CockroachDB is the exception — it
  takes a fraction and *is* cgroup-aware, so it tracks automatically.
- **`memswap_limit` is set equal to `mem_limit` on purpose.** Without it Docker
  grants swap equal to the limit, and a "4g" container quietly gets 4g RAM plus
  4g swap.

Verify a cap actually bound:

```bash
docker inspect -f '{{.HostConfig.Memory}}' bench-postgres-postgres-1
docker exec bench-postgres-postgres-1 psql -U postgres -d benchmark -c 'show shared_buffers'
```
