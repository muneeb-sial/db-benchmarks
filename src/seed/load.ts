/**
 * Streams the seed files into an engine, `loadChunk` rows at a time, so a
 * million-row table never has to be parsed whole.
 */

import type { Engine } from '../engine/engine.ts';
import { SEED_TABLES, type Row, type SeedTable } from '../engine/types.ts';
import { tablePath } from './manifest.ts';

/** Columns stored as ISO strings in the files and revived to Date on load. */
const DATE_COLUMNS = new Set(['created_at']);

function revive(row: Row): Row {
  for (const k of DATE_COLUMNS) {
    const v = row[k];
    if (typeof v === 'string') row[k] = new Date(v);
  }
  return row;
}

async function* lines(path: string): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = '';
  for await (const chunk of Bun.file(path).stream()) {
    rest += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = rest.indexOf('\n')) !== -1) {
      const line = rest.slice(0, nl);
      rest = rest.slice(nl + 1);
      if (line) yield line;
    }
  }
  rest += decoder.decode();
  if (rest.trim()) yield rest;
}

export async function loadTable(engine: Engine, table: SeedTable, chunk: number): Promise<number> {
  let batch: Row[] = [];
  let total = 0;
  for await (const line of lines(tablePath(table))) {
    batch.push(revive(JSON.parse(line) as Row));
    if (batch.length >= chunk) {
      await engine.seedChunk(table, batch);
      total += batch.length;
      batch = [];
    }
  }
  if (batch.length) {
    await engine.seedChunk(table, batch);
    total += batch.length;
  }
  return total;
}

/** Loads every seed table in dependency order. Returns load time per table in ms. */
export async function loadAll(engine: Engine, chunk: number, log: (s: string) => void): Promise<Record<string, number>> {
  const loadMs: Record<string, number> = {};
  for (const table of SEED_TABLES) {
    const t0 = performance.now();
    const n = await loadTable(engine, table, chunk);
    loadMs[table] = Math.round(performance.now() - t0);
    log(`  ${engine.name}: loaded ${n.toLocaleString('en-US')} ${table} in ${loadMs[table]}ms`);
  }
  return loadMs;
}
