# Schema

```
users (id, first_name, last_name, email UNIQUE, password, age, gender, ...)
posts (id, user_id, title, body, like_count, ...)
likes (user_id, post_id, created_at)   PRIMARY KEY (user_id, post_id)
```

The like transaction, in every engine:

```sql
BEGIN;
  UPDATE posts SET like_count = like_count + 1 WHERE id = ?;
  INSERT INTO likes (user_id, post_id, created_at) VALUES (?, ?, now());
COMMIT;
```

`posts` is always touched before `likes`. Every adapter uses that same order,
so deadlock rates are a property of the database rather than of the adapter.

IDs are assigned by the generator rather than by auto-increment, so the
workload can pick a post without a round trip and the same IDs exist in every
engine.
