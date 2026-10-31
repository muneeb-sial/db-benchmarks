# Seed data

The server never generates data at request time. It loads files from this
directory when you call `POST /:db/initialize`.

```bash
bun src/seed/generate.ts                  # standard profile
bun src/seed/generate.ts --profile smoke  # small dataset
```

This writes `data/` (gitignored):

| File | Contents |
| --- | --- |
| `users.jsonl` | `id, email, name, score, created_at, bio` |
| `posts.jsonl` | `id, user_id, title, views, like_count, created_at` |
| `likes.jsonl` | `id, post_id, user_id, created_at` |
| `documents.jsonl` | `id, doc` (JSON document) |
| `manifest.json` | seed, sizes, planted limits, doc shape, generator version |

The files are JSONL, one row per line, with dates as ISO strings. The loader
streams them in `dataset.loadChunk` rows at a time, so a million-row table is
never parsed whole. `manifest.json` is written last, so if it exists, the data
files are complete.

## How rows are made ([rows.ts](rows.ts))

- **Deterministic.** Every row is a pure function of `(seed, id)` through
  `hash32`. The same config always produces byte-identical files, and k6 can
  compute valid keys (emails, ids, time ranges) without asking the server.
- **Planted blocks.** For each configured limit `L`, a contiguous block of `L`
  user ids (and document ids) carries marker text: `pfx{L}-`, `-mid{L}-` and
  `-sfx{L}` in `name`, `zq{L}` in `bio`, and `k{L}` in documents. A search for
  `L`'s marker returns exactly `L` rows.
- **`created_at` = 2024-01-01 + id seconds**, so a time range for exactly `N`
  users is computed rather than searched for.
- **Write rows** (W1-W4) come from the same functions and are built on the
  server from the ids k6 sends, so k6 never ships row bodies.

## When initialize refuses

`POST /:db/initialize` returns **424** with instructions when:

- `data/manifest.json` does not exist (no seed yet), or
- the manifest does not match the server's config (a different profile, seed,
  sizes or limits). The server's profile comes from `BENCH_PROFILE`, so a smoke
  seed only loads into a server started with `BENCH_PROFILE=smoke`.

Regenerate with the matching `--profile` and call initialize again.
