// R6: created_at BETWEEN a AND b, with the range sized to match LIMIT users.
import exec from 'k6/execution';
import { manifest, op, pageParams, slot, summary, timedOptions } from './lib.js';

const SHAPE = __ENV.SHAPE || 'simple';
const MODE = __ENV.MODE || 'limit';
const LIMIT = Number(__ENV.LIMIT || 100);

export const options = timedOptions({ test: 'r6', shape: SHAPE, mode: MODE, limit: String(LIMIT) });
export const setup = manifest;

export default function (m) {
  // The window holds exactly LIMIT users, so a LIMIT-sized page over it starts at 0.
  op('GET', 'read/r6', { shape: SHAPE, mode: MODE, limit: LIMIT, ...pageParams(m, MODE, LIMIT, LIMIT, slot(exec)) });
}

export const handleSummary = summary;
