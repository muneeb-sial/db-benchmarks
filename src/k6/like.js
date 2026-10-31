/**
 * The like transaction: posts.like_count += 1 and insert into likes, atomically.
 *   CONTENTION=uniform  likes spread over every post
 *   CONTENTION=hot      likes concentrate on HOT_POSTS posts
 * teardown() runs the integrity check and fails the run on any mismatch.
 */
import exec from 'k6/execution';
import { control, hash32, manifest, op, slot, summary, timedOptions } from './lib.js';

const CONTENTION = __ENV.CONTENTION || 'uniform';
const HOT_POSTS = Number(__ENV.HOT_POSTS || 10);

export const options = timedOptions({ test: 'like', contention: CONTENTION });

export function setup() {
  const m = manifest();
  control('POST', 'reset/tx_likes');
  return m;
}

export default function (m) {
  const n = slot(exec);
  const posts = CONTENTION === 'hot' ? Math.min(HOT_POSTS, m.posts) : m.posts;
  op('POST', 'like', { post: 1 + (hash32(m.seed, n, 31) % posts), user: 1 + (hash32(m.seed, n, 32) % m.users) });
}

export function teardown() {
  const v = control('GET', 'verify');
  if (v.skipped) return;
  if (!v.ok) throw new Error(`like_count integrity check failed: ${v.mismatches} of ${v.checked} posts drifted`);
  console.log(`integrity ok: ${v.checked} posts checked, 0 mismatches`);
}

export const handleSummary = summary;
