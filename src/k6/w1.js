// W1: single inserts, no unique key. Fixed work: ROWS inserts shared across VUS.
import exec from 'k6/execution';
import { control, fixedOptions, manifest, op, slot, summary } from './lib.js';

const ROWS = Number(__ENV.ROWS || 20000);

export const options = fixedOptions({ test: 'w1' }, ROWS);

export function setup() {
  const m = manifest();
  control('POST', 'reset/w_plain');
  return m;
}

export default function () {
  op('POST', 'write/w1', { id: slot(exec) });
}

export const handleSummary = summary;
