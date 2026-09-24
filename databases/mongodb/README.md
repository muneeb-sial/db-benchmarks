# MongoDB

```bash
docker compose up -d --wait
node ../../src/cli.ts --db mongodb
```

Driver: official `mongodb` v6. Verified on Node and Bun.

## Do not upgrade to mongodb 7.x

Pinned to `^6` deliberately. **Driver 7.x fails to load on Bun**:

```
node:v8 isBuildingSnapshot is not yet implemented in Bun
```

Cross-runtime coverage is the point of this repo, so staying on 6.x (verified
working on both Node and Bun) is worth more than the major bump. Re-test on Bun
before changing this — the harness will skip MongoDB rather than fail, so a
regression here shows up as a quietly missing engine rather than an error.

## Replica set

The compose file runs a single-node replica set rather than a standalone `mongod`.

Two details make the single-node set work:

- **The healthcheck is also the initializer.** It runs `rs.status()` and falls
  back to `rs.initiate()` on the first pass, so the container reports healthy
  exactly when the set is usable. No separate init container.
- **The client connects with `?directConnection=true`.** With
  `?replicaSet=rs0`, the driver performs topology discovery against the
  hostname the set advertises, which for a single node in Docker is often
  unreachable from the host and surfaces as a server-selection timeout.

## Fairness notes

- On a single-node set, `w:"majority"` is satisfied by one node, so **MongoDB
  pays no replication cost in these results**. Recorded in every result file.
- `--wiredTigerCacheSizeGB` is set explicitly. Left alone, WiredTiger sizes
  itself from the cgroup to roughly 1.5GB under a 4g cap, while Postgres and
  MySQL sit at their hardcoded 128MB defaults — a 12× advantage that looks like
  speed.
