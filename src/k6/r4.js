/**
 * R4: walk the whole table page by page (offset or cursor). Each VU does one
 * walk; every request is tagged with its page number, so per-page latency
 * comes straight out of the k6 JSON output (--out json=...).
 */
import { manifest, op, perVuOptions, summary } from './lib.js';

const SHAPE = __ENV.SHAPE || 'simple';
const MODE = __ENV.MODE || 'cursor';
const LIMIT = Number(__ENV.LIMIT || 1000);
const MAX_PAGES = Number(__ENV.MAX_PAGES || 1000);

export const options = perVuOptions({ test: 'r4', shape: SHAPE, mode: MODE, limit: String(LIMIT) });
export const setup = manifest;

export default function () {
  let offset = 0;
  let after = 0;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = { shape: SHAPE, mode: MODE, limit: LIMIT };
    if (MODE === 'offset') params.offset = offset;
    if (MODE === 'cursor') params.after = after;
    // 501 mid-walk: the engine cannot page this deep (Elasticsearch stops at 10,000 rows); the walk ends there.
    const res = op('GET', 'read/r4', params, { page: String(page) }, [501]);
    if (res.ended) {
      if (__VU === 1) console.log(`walk ended at page ${page}: ${res.body}`);
      break;
    }
    if (!res.ok || res.rows < LIMIT) break;
    offset += LIMIT;
    if (MODE === 'cursor') {
      if (res.last == null) break;
      after = res.last;
    }
    if (MODE === 'limit') break; // limit mode is R1's single page by definition
  }
}

export const handleSummary = summary;
