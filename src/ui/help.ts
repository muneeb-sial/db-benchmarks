/**
 * Every hover tooltip on the page, in one place, so both tabs explain things
 * the same way. app.ts and suite.ts read from here; applyStaticTips() covers
 * the elements that are in index.html from the start.
 */

/** Run-timing fields, shared by the Suite tab and the Single tab's k6 panel. */
export const TIMING_HELP = {
  duration:
    'Duration: how many seconds k6 measures each run (one cell at one concurrency level). ' +
    'Only this window counts in the results: req/s, latency percentiles, rows.\n\n' +
    'Applies to the timed tests: R1–R3, R5–R10 and the like transaction. ' +
    'W1–W4 and R4 ignore it; they do a fixed amount of work (rows to insert, pages to walk) and time all of it.',
  warmup:
    'Warmup: seconds of the same load k6 runs before the measured window, then throws away.\n\n' +
    'It lets connection pools fill, caches and query plans settle and the JIT warm up, so the slow first ' +
    'requests do not skew the numbers. 0 = no warmup. Like duration, it only applies to the timed tests.',
  vus:
    'VUs (virtual users): how many k6 workers send requests at the same time, i.e. the concurrency. ' +
    'Each worker sends its next request as soon as the last one returns (closed loop).',
};

export const DB_HELP: Record<string, string> = {
  postgres: 'PostgreSQL 16. READ COMMITTED; like-tx waits on the row lock, no client retries. Runs every test.',
  cockroachdb: 'CockroachDB (Postgres wire protocol). SERIALIZABLE: conflicts abort with 40001 and are retried and counted. No full-text.',
  mysql: 'MySQL 8, pinned to READ-COMMITTED to match Postgres. JSON via functional / multi-valued indexes. Runs every test.',
  mssql: 'SQL Server 2022 with READ_COMMITTED_SNAPSHOT on. No JSON type and no full-text in the image: W4, R10 and full-text are N/A.',
  mongodb: 'MongoDB on a single-node replica set (needed for transactions). Joins are $lookup, offset is skip(), LIKE is a regex.',
  cassandra: 'Cassandra 5. No joins, no OFFSET, no ORDER BY on non-clustering columns, no cross-partition transaction: most cells are N/A, each with its reason.',
  elasticsearch: 'Elasticsearch 8 over REST. No joins or transactions; offset stops at 10,000; every field is indexed by its mapping.',
};

export const SHAPE_HELP: Record<string, string> = {
  simple: 'simple: users only. Ordered and paged on users.id.',
  'single-join': 'single-join: users ⋈ posts. One row per post; ordered and paged on posts.id.',
  'multi-join': 'multi-join: users ⋈ posts ⋈ likes. One row per like; ordered and paged on likes.id (the largest table).',
};

export const MODE_HELP: Record<string, string> = {
  limit: 'limit: LIMIT n from the start. The baseline page.',
  offset: 'offset: LIMIT n OFFSET m at a varying m. Expected to slow down the deeper m goes, since skipped rows are still read.',
  cursor: 'cursor (keyset): WHERE key > last LIMIT n from a varying start. Expected to stay flat at any depth.',
};

export const INDEX_HELP: Record<string, string> = {
  'name-prefix': 'name-prefix: btree on users.name, so prefix LIKE (R9) can use an index. Postgres uses text_pattern_ops.',
  fulltext: 'fulltext: full-text index on users.bio (tsvector GIN / MySQL FULLTEXT / Mongo text). MySQL and Mongo need it for full-text at all.',
  'json-top': 'json-top: index on documents.doc.tag, the top-level JSON field R10 filters on.',
  'json-nested': 'json-nested: index on the nested field doc.l1.l2.value (R10 nested).',
  'json-array': 'json-array: index on the doc.tags array, for R10 array-contains (GIN / multi-valued / multikey).',
};

export const TABLE_HELP: Record<string, string> = {
  w_plain: 'w_plain: W1 and W3 write here (no unique key).',
  w_uk: 'w_uk: W2 writes here (unique email). Truncate before a W2 run you do by hand, or the inserts collide.',
  w_docs: 'w_docs: W4 JSON documents go here.',
  tx_likes: 'tx_likes: the like transaction table. Truncating it also resets every posts.like_count to 0.',
};

const R7_HELP: Record<string, string> = {
  'count-all': 'count-all: COUNT(*) over every user.',
  'count-indexed': 'count-indexed: COUNT(*) on a created_at range (indexed), about reads.r7.countRangeFraction of users.',
  'count-unindexed': 'count-unindexed: COUNT(*) where score < cutoff (no index, so a full scan).',
  'sum-views': 'sum-views: SUM(views) over all posts.',
  'posts-per-user': 'posts-per-user: users ⋈ posts, GROUP BY user.',
  'likes-per-post': 'likes-per-post: posts ⋈ likes, GROUP BY post.',
  'likes-per-user': 'likes-per-user: users ⋈ posts ⋈ likes, GROUP BY user.',
};

const R10_HELP: Record<string, string> = {
  'top-level': 'top-level: doc.tag = marker.',
  nested: 'nested: doc.l1.l2.value = marker (depth from reads.r10.docShape).',
  'array-contains': 'array-contains: the doc.tags array contains the marker.',
};

/** Per-option help for a field's select, by "<test>.<field>" or "<field>". */
export const OPTION_HELP: Record<string, Record<string, string>> = {
  shape: SHAPE_HELP,
  mode: MODE_HELP,
  'r5.kind': { id: 'id: point lookup by primary key.', multi: 'multi: one id IN (...) multi-get.' },
  'r5.hot': { '0': 'uniform: every user equally likely.', '1': 'hot: 80% of lookups hit 20% of the users (reads.r5.hotKey).' },
  'r7.variant': R7_HELP,
  'r8.kind': { topn: 'topn: ORDER BY a key, LIMIT n.', fullsort: 'fullsort: sort users with id ≤ reads.r8.fullSortRowCap on score, no limit.' },
  'r8.key': {
    indexed: 'indexed: ORDER BY created_at (has an index, so it can stop early).',
    unindexed: 'unindexed: ORDER BY score (no index: the engine must sort).',
  },
  'r9.kind': { like: 'like: LIKE / regex on users.name.', fulltext: 'fulltext: full-text match on users.bio.' },
  'r9.pattern': {
    prefix: "prefix: name LIKE 'pfx100-%'. The one pattern a btree index can help.",
    contains: "contains: name LIKE '%-mid100-%'. No index helps; a scan.",
    suffix: "suffix: name LIKE '%-sfx100'. No index helps; a scan.",
  },
  'r9.index': { '': '(none): run against whatever indexes exist now.', ...INDEX_HELP },
  'r10.variant': R10_HELP,
  'r10.index': { '': '(none): run against whatever indexes exist now.', ...INDEX_HELP },
  'like.contention': {
    uniform: 'uniform: likes spread across every post.',
    hot: 'hot: likes concentrate on 10 posts; this is where engines diverge (lock queues, retries, conflicts).',
  },
};

/** Field help, by "<test>.<field>" first, then "<field>". */
export const FIELD_HELP: Record<string, string> = {
  shape: 'Query shape: how many tables the read joins.',
  mode: 'Read mode: how the result is paged.',
  limit: 'Rows per page (LIMIT n).',
  offset: 'OFFSET m: how many rows to skip first (offset mode). k6 picks a varying value during a load run.',
  after: 'Cursor start: return rows with key > this value (cursor mode). During R4 walks, k6 passes the last key of the previous page.',
  email: 'Which user to look up: user<id>@bench.test. k6 picks a fresh random user per request.',
  id: 'Primary key to fetch. k6 picks one per request (uniform or hot).',
  'r5.size': 'Keys per IN (...) list.',
  slot: 'Seed for which keys the multi-get uses; the same slot always gives the same keys.',
  'r4.max_pages': 'k6 only: stop each VU’s walk after this many pages (reads.r4.maxPages in a suite).',
  'r9.limit': 'Must be a planted limit: a block of exactly this many users carries the marker, so a search returns exactly this many rows.',
  'r10.limit': 'Must be a planted limit: exactly this many documents carry the marker.',
  'r9.index': 'k6 only: make sure this index exists during the run. Dropped at the end only if the run had to build it.',
  'r10.index': 'k6 only: make sure this index exists during the run. Dropped at the end only if the run had to build it.',
  'w1.id': 'Row id to insert. Inserting the same id twice fails on the primary key.',
  'w1.rows': 'k6 only: total inserts, shared across the VUs (fixed work).',
  'w2.id': 'Row id to insert into w_uk.',
  'w2.dup': 'Reuse the email of this existing id, to force a unique-key violation (409). Leave empty for a normal insert.',
  'w2.rows': 'k6 only: total inserts; writes.w2.duplicateRatio of them reuse an email on purpose.',
  'w3.start': 'First id of the batch; ids start..start+size-1.',
  'w3.size': 'Rows in the one batch insert.',
  'w3.max_rows': 'k6 only: total rows for the run, as batches of `size` (at least one per VU).',
  'w4.id': 'Document id to insert.',
  'w4.rows': 'k6 only: total document inserts, shared across the VUs.',
  post: 'Post to like (bump posts.like_count).',
  user: 'User who likes it. The same (user, post) twice is a conflict: the transaction rolls back.',
  ...TIMING_HELP,
};

/** Help for a field: its own text, plus what the selected option means. */
export function fieldHelp(test: string, name: string, value?: string): string {
  const base = FIELD_HELP[`${test}.${name}`] ?? FIELD_HELP[name] ?? '';
  const opt = (OPTION_HELP[`${test}.${name}`] ?? OPTION_HELP[name])?.[value ?? ''];
  return [base, opt].filter(Boolean).join('\n\n');
}

/** Option-level help for a select (shown when hovering an option, where the browser supports it). */
export function optionHelp(test: string, name: string): Record<string, string> | undefined {
  return OPTION_HELP[`${test}.${name}`] ?? OPTION_HELP[name];
}

/** Tooltips for elements that exist in index.html from the start, by id. */
const STATIC_TIPS: Record<string, string> = {
  profile: 'The server’s profile (BENCH_PROFILE): which bench.config.json profile it runs, and so which seed size it expects.',
  'tab-single': 'Run one test at a time: a single request, or one k6 load run.',
  'tab-suite': 'Run many tests × databases × concurrency levels in one go, streamed live.',
  db: 'Which database the Single tab talks to. Hover the Suite tab’s database list for what each one can and cannot do.',
  'db-status': 'Whether this database is initialized (seed loaded) on this server.',
  init: 'docker compose down -v (old container and all data gone) → up -d --wait → create schema → load the seed → baseline indexes → every supported search index.',
  test: 'The test to run. Its description and parameters appear below.',
  coverage: 'This engine cannot run this combination honestly; the reason is shown, and the server would answer 501.',
  preview: 'The exact request “Execute once” will send.',
  execute: 'Send that one request. Shows the status, rows, the server-side DB time and the browser round trip.',
  'k6-run': 'Run k6 against this server with these VUs / duration / warmup and the test’s parameters; output streams below.',
  'k6-stop': 'Stop the k6 run (the server kills the process).',
  'index-kind': 'Search index to build or drop. Initialize builds all supported ones; a reinitialize is the only thing that removes them otherwise.',
  'index-create': 'Build the selected index (no-op if it already exists). The badges above update.',
  'index-drop': 'Drop the selected index (no-op if it is already gone). Stays dropped until you build it again or reinitialize.',
  'reset-table': 'Scratch table to empty.',
  reset: 'Truncate the selected scratch table. For tx_likes this also resets every like_count to 0.',
  verify: 'Integrity check: every posts.like_count must equal the real count of its likes. Run it after a like-transaction load.',
  's-defaults': 'Reset the matrix (concurrency, limits, shapes, modes, duration, warmup) to the server’s bench.config.json.',
  's-limits': 'Rows per page / result size, comma-separated ("100,1k"). Every paged cell runs at each. R9 and R10 only run the limits the seed planted.',
  's-init': 'Recreate each database’s container and load the seed before its cells (a clean start). Untick to reuse what is already loaded.',
  's-indexes': 'With reinitialize: also build every supported search index. No-index R9/R10 cells drop theirs for the moment; the suite rebuilds it.',
  's-verbose': 'Also stream k6’s raw output for every run. Makes the log much longer.',
  's-adv-on': 'Use the JSON below for this run. Off: the box is ignored entirely.',
  's-advanced': 'Per-run overrides in bench.config.json shape (writes.*, reads.r4, reads.r5), merged over the server’s profile.',
  's-adv-reset': 'Put the config’s current values back in the box.',
  's-plan': 'What the run will do: k6 runs per database (and N/A cells), and an estimate for the timed cells.',
  's-run': 'Start the suite. Every step streams into the Response window; results fill the table below as they finish.',
  's-stop': 'Stop the suite. The k6 run in flight is killed, and any index the run dropped is rebuilt.',
  's-progress-count': 'k6 runs finished / total.',
  's-ok': 'Runs that finished with results.',
  's-na': 'Cells the engine cannot run honestly (not run, reason in the log).',
  's-failed': 'Runs that errored (k6 exit, index setup). The log shows k6’s last lines.',
  's-summary': 'The run’s summary.md (also written to results/<run-id>/).',
  's-filter': 'Show only rows containing every word, e.g. "postgres r1 32".',
  'm-status': '200 ok · 409 unique-key hit (expected in W2) · 412 not initialized · 424 no seed · 501 N/A on this engine.',
  'm-rows': 'Rows the database returned (or wrote) for this request.',
  'm-db': 'Server-side time of the database call alone (Server-Timing header), without HTTP or JSON.',
  'm-rtt': 'Browser round trip: HTTP + server + database. The gap to DB time is overhead.',
  clear: 'Clear the Response window.',
  output: 'Responses and streamed logs. Green: results · amber: N/A · red: failures.',
};

/** Column help for the results and history tables, by header text. */
const HEADER_TIPS: Record<string, string> = {
  DB: 'Database.',
  Cell: 'Test variant: test, shape, mode, limit (+index when it runs with its index).',
  VUs: 'Concurrency level for this run.',
  'req/s': 'Throughput: completed requests per second during the measured window.',
  'http p50': 'Median end-to-end latency as k6 saw it (ms).',
  'http p95': '95th percentile end-to-end latency (ms).',
  'http p99': '99th percentile end-to-end latency (ms): the tail.',
  'db p50': 'Median server-side DB time (ms), without HTTP.',
  'db p95': '95th percentile server-side DB time (ms).',
  rows: 'Average rows per request.',
  err: 'Requests that errored (409 unique-key hits are counted separately, not here).',
  Time: 'When the request was sent.',
  Request: 'Method and URL.',
  Status: 'HTTP status.',
  Rows: 'Rows returned or written.',
  'DB ms': 'Server-side DB time.',
  'RTT ms': 'Browser round trip.',
};

/** Puts a tooltip (and the help cursor) on an element. */
export function tip(el: Element | null, text: string): void {
  if (!(el instanceof HTMLElement) || !text) return;
  el.title = text;
  el.classList.add('cursor-help');
}

export function applyStaticTips(): void {
  for (const [id, text] of Object.entries(STATIC_TIPS)) {
    const el = document.getElementById(id);
    // A label wrapping an input is the larger hover target.
    tip(el?.closest('label') ?? el, text);
  }
  for (const th of document.querySelectorAll('th')) tip(th, HEADER_TIPS[th.textContent?.trim() ?? ''] ?? '');
  const pick: Record<string, string> = {
    all: 'Tick every test.',
    reads: 'Tick only the read tests (R1–R10).',
    writes: 'Tick only the writes (W1–W4) and the like transaction.',
    none: 'Untick every test.',
  };
  for (const btn of document.querySelectorAll<HTMLElement>('[data-pick]')) tip(btn, pick[btn.dataset.pick ?? ''] ?? '');
}
