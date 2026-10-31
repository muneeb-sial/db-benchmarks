/**
 * Benchmark server. Each request runs exactly one database operation; k6
 * supplies the concurrency and does the timing.
 *
 *   bun src/index.ts            (PORT=3000, BENCH_PROFILE=standard)
 *
 *   GET  /                        the runner UI (src/ui)
 *   GET  /results                 browse past runs in results/ (src/ui/results.html)
 *   POST /api/k6?script&ENV...    run a k6 script against this server, output streamed
 *   GET  /api/config              resolved bench.config.json, profile names, tests, databases
 *   POST /api/suite/plan          dry run of a suite request: cells, N/A, run count, estimate
 *   POST /api/suite               run a suite (many tests x dbs x levels), NDJSON events streamed
 *   GET  /api/runs                every run in results/, newest first, with counts
 *   GET  /api/runs/:id            one run: request, config, outcomes, initialize, file tree
 *   GET  /api/runs/:id/file?path  one file inside a run folder
 *   GET  /api/runs/:id/summary    a finished run's summary.md
 *   POST /:db/initialize         fresh container (compose down -v, up -d --wait), load seed/data,
 *                                build every supported search index (?indexes=none to skip)
 *                                (424 if no seed, 503 if docker fails)
 *   GET  /:db/status              initialized?, load times, manifest
 *   GET  /:db/coverage            every op with "ok" or its N/A reason
 *   GET  /:db/read/:test?...      r1..r10
 *   POST /:db/write/:test?...     w1..w4
 *   POST /:db/like?post&user      one like transaction
 *   GET  /:db/verify              like_count integrity check
 *   POST|DELETE /:db/index/:kind  build / drop an R9/R10 index
 *   POST /:db/reset/:table        truncate a scratch table
 */

import { resolve } from 'node:path';
import { CONFIG_PATH, loadConfig } from './config/config.ts';
import { PATHS } from './config/paths.ts';
import type { Engine } from './engine/engine.ts';
import { INDEX_KINDS, SCRATCH_TABLES } from './engine/types.ts';
import { BadParams, UniqueViolation } from './http/errors.ts';
import { errorResponse, json, timed } from './http/response.ts';
import { runK6 } from './k6/runner.ts';
import { coverage, prepareRead, prepareWrite, type Prepared } from './http/ops.ts';
import { getQuery, oneOf, positiveInt } from './http/params.ts';
import { closeAll, DATABASES, engineFor, engineInfo } from './engines/registry.ts';
import { dbState, initialize, isInitializing, ready, setIndex } from './databases/state.ts';
import type { SuiteEvent } from './suite/events.ts';
import { ALL_TESTS } from './suite/matrix.ts';
import { getRun, listRuns, runFile } from './suite/results.ts';
import { editableDefaults, prepareSuite, runSuite } from './suite/run.ts';
import ui from './ui/index.html';
import resultsUi from './ui/results.html';

const cfg = await loadConfig();

type Req = Request & { params: Record<string, string> };
/** The part of Bun's Server a handler uses. */
type Srv = { timeout(req: Request, seconds: number): void };

/** Wraps a handler so thrown HttpErrors become their status codes. */
const handle =
  (fn: (req: Req, srv: Srv) => Promise<Response>) =>
  async (req: Req, srv: Srv): Promise<Response> => {
    try {
      return await fn(req, srv);
    } catch (err) {
      return errorResponse(err);
    }
  };

async function execute(engine: Engine, p: Prepared): Promise<Response> {
  const reason = engine.support(p.op, p.cell);
  if (reason) throw engine.notSupported(p.op, reason);
  const t0 = performance.now();
  try {
    const result = await p.run();
    return timed(result, performance.now() - t0);
  } catch (err) {
    // A unique-key hit is an expected W2 outcome; keep its latency.
    if (err instanceof UniqueViolation) return timed({ rows: 0, error: err.code }, performance.now() - t0, 409);
    throw err;
  }
}

// Built (dist/): Bun resolves the pre-bundled page's files relative to the
// working directory, so serve from the bundle's own folder. Every other path
// is absolute (config/paths.ts), so nothing else depends on the cwd.
if (process.env.NODE_ENV === 'production') process.chdir(import.meta.dir);

const server = Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  // k6 at 64 VUs against a slow multi-join can hold a request well past Bun's 10s default.
  idleTimeout: 255,
  // From source: the page is bundled on the fly with hot reload. The build sets
  // NODE_ENV=production and ships the page pre-bundled.
  development: process.env.NODE_ENV !== 'production',
  routes: {
    '/': ui,
    '/results': resultsUi,
    '/api/status': () => json({ ok: true, profile: cfg.profile, databases: DATABASES }),
    '/api/k6': { POST: handle(async (req) => runK6(req, new URL(req.url).origin)) },

    '/api/config': handle(async () => {
      const file = Bun.file(CONFIG_PATH);
      const raw = (await file.exists()) ? ((await file.json()) as { profiles?: Record<string, unknown> }) : {};
      return json({
        profile: cfg.profile,
        config: cfg,
        editable: editableDefaults(cfg),
        profiles: Object.keys(raw.profiles ?? {}),
        tests: ALL_TESTS,
        databases: DATABASES,
      });
    }),

    /** Dry run: the plan (cells, N/A, run count, estimate) for a suite request, without running it. */
    '/api/suite/plan': { POST: handle(async (req) => json((await prepareSuite(await req.json(), cfg)).plan)) },

    '/api/suite': {
      POST: handle(async (req, srv) => {
        // Validation errors are a plain 4xx before the stream starts.
        const suite = await prepareSuite(await req.json(), cfg);
        // A suite runs for minutes to hours, with quiet stretches between lines.
        srv.timeout(req, 0);
        const abort = new AbortController();
        req.signal.addEventListener('abort', () => abort.abort());
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            const emit = (e: SuiteEvent): void => {
              try {
                controller.enqueue(encoder.encode(JSON.stringify(e) + '\n'));
              } catch {
                abort.abort(); // client went away
              }
            };
            try {
              await runSuite(suite, cfg, new URL(req.url).origin, emit, abort.signal);
            } catch (err) {
              emit({ type: 'error', message: (err as Error).message });
            }
            try {
              controller.close();
            } catch {
              /* already closed by the client */
            }
          },
          cancel() {
            abort.abort();
          },
        });
        return new Response(body, { headers: { 'content-type': 'application/x-ndjson', 'cache-control': 'no-cache' } });
      }),
    },

    '/api/runs': handle(async () => json(await listRuns())),
    '/api/runs/:id': handle(async (req) => json(await getRun(req.params.id!))),
    '/api/runs/:id/file': handle(async (req) => runFile(req.params.id!, getQuery(req).path ?? '')),

    '/api/runs/:id/summary': handle(async (req) => {
      const id = req.params.id!;
      if (!/^[\w-]+$/.test(id)) throw new BadParams('bad run id');
      const file = Bun.file(resolve(PATHS.results, id, 'summary.md'));
      if (!(await file.exists())) return json({ error: 'not_found', message: `no summary for run ${id}` }, 404);
      return new Response(file, { headers: { 'content-type': 'text/markdown; charset=utf-8' } });
    }),

    '/:db/initialize': {
      POST: handle(async (req, srv) => {
        // Recreating a container plus a standard-profile load can outlast the idle timeout.
        srv.timeout(req, 0);
        // ?indexes=none skips the search indexes (baseline indexes only).
        const indexes = getQuery(req).indexes !== 'none';
        return json(await initialize(req.params.db!, cfg, console.log, { indexes }));
      }),
    },

    '/:db/status': handle(async (req) => {
      const db = req.params.db!;
      const s = dbState(db);
      return json({ db, initialized: Boolean(s), initializing: isInitializing(db), ...(s ?? {}) });
    }),

    '/:db/coverage': handle(async (req) => json(coverage(await engineInfo(req.params.db!)))),

    '/:db/read/:test': {
      GET: handle(async (req) => {
        const db = req.params.db!;
        const s = ready(db);
        const engine = await engineFor(db);
        return execute(engine, prepareRead({ engine, cfg, plan: s.plan }, req.params.test!, getQuery(req)));
      }),
    },

    '/:db/write/:test': {
      POST: handle(async (req) => {
        const db = req.params.db!;
        const s = ready(db);
        const engine = await engineFor(db);
        return execute(engine, prepareWrite({ engine, cfg, plan: s.plan }, req.params.test!, getQuery(req)));
      }),
    },

    '/:db/like': {
      POST: handle(async (req) => {
        const db = req.params.db!;
        const s = ready(db);
        const engine = await engineFor(db);
        const q = getQuery(req);
        const post = positiveInt(q, 'post');
        const user = positiveInt(q, 'user');
        if (post > s.plan.posts || user > s.plan.users) throw new BadParams('post or user out of range');
        return execute(engine, { op: 'like', cell: {}, run: () => engine.likeTx(post, user) });
      }),
    },

    '/:db/verify': handle(async (req) => {
      const db = req.params.db!;
      ready(db);
      const engine = await engineFor(db);
      const reason = engine.support('like', {});
      if (reason) return json({ db, skipped: reason });
      const check = await engine.verifyLikeCounts();
      return json({ db, ...check, ok: check.mismatches === 0 }, check.mismatches === 0 ? 200 : 422);
    }),

    '/:db/index/:kind': {
      POST: handle(async (req) => indexOp(req, 'create')),
      DELETE: handle(async (req) => indexOp(req, 'drop')),
    },

    '/:db/reset/:table': {
      POST: handle(async (req) => {
        const db = req.params.db!;
        ready(db);
        const engine = await engineFor(db);
        const table = oneOf({ table: req.params.table! }, 'table', SCRATCH_TABLES);
        const t0 = performance.now();
        await engine.truncateScratch(table);
        return timed({ table }, performance.now() - t0);
      }),
    },
  },

  fetch: () => json({ error: 'not_found', message: 'see the route list at the top of src/index.ts' }, 404),
});

async function indexOp(req: Req, action: 'create' | 'drop'): Promise<Response> {
  const db = req.params.db!;
  ready(db);
  const engine = await engineFor(db);
  const kind = oneOf({ kind: req.params.kind! }, 'kind', INDEX_KINDS);
  const reason = engine.support('index', { kind });
  if (reason) throw engine.notSupported(`index ${kind}`, reason);
  const ms = await setIndex(db, engine, kind, action === 'create');
  // null: it was already in that state, nothing ran.
  return timed({ kind, action, changed: ms !== null, indexes: ready(db).indexes }, ms ?? 0);
}

console.log(`bench server on ${server.url} (profile ${cfg.profile})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await closeAll();
    process.exit(0);
  });
}
