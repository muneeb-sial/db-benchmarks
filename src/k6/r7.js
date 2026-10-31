/**
 * R7: aggregates. VARIANT = count-all | count-indexed | count-unindexed |
 * sum-views | posts-per-user | likes-per-post | likes-per-user
 */
import { manifest, op, summary, timedOptions } from './lib.js';

const VARIANT = __ENV.VARIANT || 'count-all';

export const options = timedOptions({ test: 'r7', variant: VARIANT });
export const setup = manifest;

export default function () {
  op('GET', 'read/r7', { variant: VARIANT });
}

export const handleSummary = summary;
