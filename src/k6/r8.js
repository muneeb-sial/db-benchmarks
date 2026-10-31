/**
 * R8: sorting.
 *   KIND=topn      SHAPE, KEY=indexed (created_at) | unindexed (score), LIMIT
 *   KIND=fullsort  full sort on score, no limit, over a capped slice (config)
 */
import { manifest, op, summary, timedOptions } from './lib.js';

const KIND = __ENV.KIND || 'topn';
const SHAPE = __ENV.SHAPE || 'simple';
const KEY = __ENV.KEY || 'indexed';
const LIMIT = Number(__ENV.LIMIT || 100);

export const options = timedOptions(
  KIND === 'fullsort' ? { test: 'r8', kind: KIND } : { test: 'r8', kind: KIND, shape: SHAPE, key: KEY, limit: String(LIMIT) },
);
export const setup = manifest;

export default function () {
  if (KIND === 'fullsort') op('GET', 'read/r8', { kind: 'fullsort' });
  else op('GET', 'read/r8', { kind: 'topn', shape: SHAPE, key: KEY, limit: LIMIT });
}

export const handleSummary = summary;
