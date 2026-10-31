/**
 * R10: JSON filters. VARIANT = top-level | nested | array-contains.
 * INDEX=json-top|json-nested|json-array makes sure that index exists for the run. Initialize
 * builds it by default; it is only dropped in teardown() if setup() had to build it.
 */
import { ensureIndex, manifest, op, restoreIndex, summary, timedOptions } from './lib.js';

const VARIANT = __ENV.VARIANT || 'top-level';
const LIMIT = Number(__ENV.LIMIT || 100);
const INDEX = __ENV.INDEX || '';

export const options = timedOptions({ test: 'r10', variant: VARIANT, limit: String(LIMIT), index: INDEX || 'none' });

export function setup() {
  return { ...manifest(), builtIndex: ensureIndex(INDEX) };
}

export default function () {
  op('GET', 'read/r10', { variant: VARIANT, limit: LIMIT });
}

export function teardown(m) {
  restoreIndex(INDEX, m.builtIndex);
}

export const handleSummary = summary;
