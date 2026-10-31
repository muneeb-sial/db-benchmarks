// R3: `score < cutoff` on a column with no index (about half the rows match).
import exec from 'k6/execution';
import { manifest, op, pageParams, slot, spanFor, summary, timedOptions } from './lib.js';

const SHAPE = __ENV.SHAPE || 'simple';
const MODE = __ENV.MODE || 'limit';
const LIMIT = Number(__ENV.LIMIT || 100);

export const options = timedOptions({ test: 'r3', shape: SHAPE, mode: MODE, limit: String(LIMIT) });
export const setup = manifest;

export default function (m) {
  const span = Math.floor(spanFor(m, SHAPE) / 2);
  op('GET', 'read/r3', { shape: SHAPE, mode: MODE, limit: LIMIT, ...pageParams(m, MODE, LIMIT, span, slot(exec)) });
}

export const handleSummary = summary;
