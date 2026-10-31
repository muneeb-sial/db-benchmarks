// W4: raw JSON document inserts, one per request. Fixed work: ROWS inserts.
import exec from 'k6/execution';
import { control, fixedOptions, manifest, op, slot, summary } from './lib.js';

const ROWS = Number(__ENV.ROWS || 20000);

export const options = fixedOptions({ test: 'w4' }, ROWS);

export function setup() {
  const m = manifest();
  control('POST', 'reset/w_docs');
  return m;
}

export default function () {
  op('POST', 'write/w4', { id: slot(exec) });
}

export const handleSummary = summary;
