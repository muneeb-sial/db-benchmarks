/**
 * Deterministic dataset generation.
 *
 * Two deliberate departures from the original dataset.js:
 *
 *   1. faker is seeded, so every engine and every run sees byte-identical data.
 *      Previously each run generated fresh random data, which meant results
 *      were never strictly comparable across runs.
 *
 *   2. Email uniqueness uses a Set. The original did `data.find(...)` per row,
 *      which is O(n^2) -- roughly 2.4 billion string comparisons at 70k rows,
 *      spent before the benchmark even started.
 *
 * IDs are assigned here rather than by the database's auto-increment. The like
 * workload has to pick a post id without a round trip, and the same ids must
 * exist in every engine for the results to line up.
 */

import { faker } from '@faker-js/faker';
import type { Post, User } from '../core/adapter.ts';

export interface Dataset {
  users: User[];
  posts: Post[];
}

export interface GenerateOptions {
  users: number;
  postsPerUser: number;
  seed?: number;
}

export function generate(opts: GenerateOptions): Dataset {
  faker.seed(opts.seed ?? 42);

  const users: User[] = [];
  const seenEmails = new Set<string>();

  for (let i = 0; i < opts.users; i++) {
    const gender = faker.person.sexType();
    const firstName = faker.person.firstName(gender);
    const lastName = faker.person.lastName();

    let email = faker.internet.email({ firstName, lastName });
    // Disambiguate rather than reroll: rerolling can loop for a long time once
    // the name space saturates, and the suffix keeps generation O(n).
    if (seenEmails.has(email)) email = `${i}.${email}`;
    seenEmails.add(email);

    users.push({
      id: i + 1,
      first_name: firstName,
      last_name: lastName,
      email,
      password: faker.internet.password(),
      age: faker.number.int({ min: 15, max: 35 }),
      gender,
      created_at: faker.date.recent(),
      updated_at: faker.date.recent(),
    });
  }

  const posts: Post[] = [];
  let postId = 1;
  for (const user of users) {
    for (let p = 0; p < opts.postsPerUser; p++) {
      posts.push({
        id: postId++,
        user_id: user.id,
        title: faker.lorem.sentence({ min: 3, max: 8 }),
        body: faker.lorem.paragraph(),
        like_count: 0,
        created_at: faker.date.recent(),
        updated_at: faker.date.recent(),
      });
    }
  }

  return { users, posts };
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size) as T[]);
  }
  return out;
}
