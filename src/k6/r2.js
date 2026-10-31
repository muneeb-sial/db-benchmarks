// R2: lookup on the unique key (email), a fresh random user each request.
import exec from 'k6/execution';
import { emailOf, hash32, manifest, op, pageParams, slot, summary, timedOptions } from './lib.js';

const SHAPE = __ENV.SHAPE || 'simple';
const MODE = __ENV.MODE || 'limit';
const LIMIT = Number(__ENV.LIMIT || 100);

export const options = timedOptions({ test: 'r2', shape: SHAPE, mode: MODE, limit: String(LIMIT) });
export const setup = manifest;

export default function (m) {
  const n = slot(exec);
  const email = emailOf(1 + (hash32(m.seed, n, 9) % m.users));
  // One user matches, so the paging window is that user's rows (a handful at most).
  op('GET', 'read/r2', { shape: SHAPE, mode: MODE, limit: LIMIT, email, ...pageParams(m, MODE, LIMIT, 1, n) });
}

export const handleSummary = summary;
