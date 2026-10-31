/**
 * W2: single inserts with the unique key enforced. SEED_ROWS rows are inserted
 * in setup() (untimed); then DUP_RATIO of the measured inserts reuse one of
 * their emails and must fail with 409, counted as uk_violations.
 */
import exec from 'k6/execution';
import { control, fixedOptions, hash32, manifest, op, slot, summary } from './lib.js';

const ROWS = Number(__ENV.ROWS || 20000);
const SEED_ROWS = Number(__ENV.SEED_ROWS || 1000);
const DUP_RATIO = Number(__ENV.DUP_RATIO || 0.1);

export const options = fixedOptions({ test: 'w2' }, ROWS);

export function setup() {
  const m = manifest();
  control('POST', 'reset/w_uk');
  for (let id = 1; id <= SEED_ROWS; id++) op('POST', 'write/w2', { id }, { phase: 'setup' });
  return m;
}

export default function (m) {
  const n = slot(exec);
  const params = { id: SEED_ROWS + n };
  if (hash32(m.seed, n, 11) / 2 ** 32 < DUP_RATIO) params.dup = 1 + (hash32(m.seed, n, 12) % SEED_ROWS);
  op('POST', 'write/w2', params);
}

export const handleSummary = summary;
