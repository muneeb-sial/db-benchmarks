/**
 * W3: batch inserts, one batch of SIZE rows per request. MAX_ROWS caps the
 * total per cell, with at least one batch per VU. The server builds the rows
 * before its timer starts, so row generation is not in db_ms.
 */
import exec from 'k6/execution';
import { control, fixedOptions, manifest, op, slot, summary, VUS } from './lib.js';

const SIZE = Number(__ENV.SIZE || 1000);
const MAX_ROWS = Number(__ENV.MAX_ROWS || 1000000);
const BATCHES = Math.max(VUS, Math.floor(MAX_ROWS / SIZE));

export const options = fixedOptions({ test: 'w3', size: String(SIZE) }, BATCHES);

export function setup() {
  const m = manifest();
  control('POST', 'reset/w_plain');
  return m;
}

export default function () {
  const n = slot(exec);
  op('POST', 'write/w3', { start: (n - 1) * SIZE + 1, size: SIZE });
}

export const handleSummary = summary;
