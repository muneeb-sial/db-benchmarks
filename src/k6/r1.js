// R1: no filter, paged. k6 run -e DB=postgres -e SHAPE=simple -e MODE=offset -e LIMIT=100 r1.js
import exec from 'k6/execution';
import { manifest, op, pageParams, slot, spanFor, summary, timedOptions } from './lib.js';

const SHAPE = __ENV.SHAPE || 'simple';
const MODE = __ENV.MODE || 'limit';
const LIMIT = Number(__ENV.LIMIT || 100);

export const options = timedOptions({ test: 'r1', shape: SHAPE, mode: MODE, limit: String(LIMIT) });
export const setup = manifest;

export default function (m) {
  const span = spanFor(m, SHAPE);
  op('GET', 'read/r1', { shape: SHAPE, mode: MODE, limit: LIMIT, ...pageParams(m, MODE, LIMIT, span, slot(exec)) });
}

export const handleSummary = summary;
