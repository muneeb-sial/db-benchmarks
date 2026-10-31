/**
 * R5: point lookups by primary key.
 *   KIND=id     SHAPE=simple|single-join|multi-join, HOT=1 for the 80/20 skewed variant
 *   KIND=multi  SIZE=100|1000 keys per `IN (...)`
 */
import exec from 'k6/execution';
import { hash32, manifest, op, slot, summary, timedOptions } from './lib.js';

const KIND = __ENV.KIND || 'id';
const SHAPE = __ENV.SHAPE || 'simple';
const HOT = __ENV.HOT === '1';
const HOT_KEYS = Number(__ENV.HOT_KEYS || 0.2);
const HOT_TRAFFIC = Number(__ENV.HOT_TRAFFIC || 0.8);
const SIZE = Number(__ENV.SIZE || 100);

const variant = KIND === 'multi' ? `multi-${SIZE}` : HOT ? 'hot' : 'uniform';
export const options = timedOptions({ test: 'r5', kind: KIND, shape: SHAPE, variant });
export const setup = manifest;

export default function (m) {
  const n = slot(exec);
  if (KIND === 'multi') {
    op('GET', 'read/r5', { kind: 'multi', size: SIZE, slot: n });
    return;
  }
  let id;
  if (HOT && hash32(m.seed, n, 21) % 1000 < HOT_TRAFFIC * 1000) {
    const hotCount = Math.max(1, Math.floor(m.users * HOT_KEYS));
    id = 1 + (hash32(m.seed, n, 22) % hotCount);
  } else {
    id = 1 + (hash32(m.seed, n, 23) % m.users);
  }
  op('GET', 'read/r5', { kind: 'id', shape: SHAPE, id });
}

export const handleSummary = summary;
