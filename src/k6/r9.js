/**
 * R9: text search on planted markers, so a search for LIMIT returns exactly LIMIT rows.
 *   KIND=like      PATTERN=prefix|contains|suffix
 *   KIND=fulltext
 *   INDEX=name-prefix|fulltext makes sure that index exists for the run. Initialize
 *   builds it by default; it is only dropped in teardown() if setup() had to build it.
 */
import { ensureIndex, manifest, op, restoreIndex, summary, timedOptions } from './lib.js';

const KIND = __ENV.KIND || 'like';
const PATTERN = __ENV.PATTERN || 'prefix';
const LIMIT = Number(__ENV.LIMIT || 100);
const INDEX = __ENV.INDEX || '';

export const options = timedOptions({
  test: 'r9', kind: KIND, pattern: KIND === 'like' ? PATTERN : '', limit: String(LIMIT), index: INDEX || 'none',
});

export function setup() {
  return { ...manifest(), builtIndex: ensureIndex(INDEX) };
}

export default function () {
  if (KIND === 'fulltext') op('GET', 'read/r9', { kind: 'fulltext', limit: LIMIT });
  else op('GET', 'read/r9', { kind: 'like', pattern: PATTERN, limit: LIMIT });
}

export function teardown(m) {
  restoreIndex(INDEX, m.builtIndex);
}

export const handleSummary = summary;
