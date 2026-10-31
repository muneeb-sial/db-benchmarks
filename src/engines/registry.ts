/**
 * Database name → engine class. Engines load lazily, so a run against Postgres
 * never imports the Cassandra driver. One connected instance per database.
 */

import type { Engine } from '../engine/engine.ts';
import { UnknownDatabase } from '../http/errors.ts';

const LOADERS: Record<string, () => Promise<Engine>> = {
  postgres: async () => new (await import('./postgres.ts')).PostgresEngine(),
  cockroachdb: async () => new (await import('./cockroachdb.ts')).CockroachEngine(),
  mysql: async () => new (await import('./mysql.ts')).MySqlEngine(),
  mssql: async () => new (await import('./mssql.ts')).MsSqlEngine(),
  mongodb: async () => new (await import('./mongodb.ts')).MongoEngine(),
  cassandra: async () => new (await import('./cassandra.ts')).CassandraEngine(),
  elasticsearch: async () => new (await import('./elasticsearch.ts')).ElasticEngine(),
};

export const DATABASES = Object.keys(LOADERS);

const instances = new Map<string, Promise<Engine>>();

/** An unconnected instance, for questions that need no database (coverage). */
export function engineInfo(db: string): Promise<Engine> {
  const load = LOADERS[db];
  if (!load) throw new UnknownDatabase(db, DATABASES);
  return load();
}

export function engineFor(db: string): Promise<Engine> {
  const load = LOADERS[db];
  if (!load) throw new UnknownDatabase(db, DATABASES);
  let p = instances.get(db);
  if (!p) {
    p = load().then(async (engine) => {
      await engine.connect();
      return engine;
    });
    // A failed connect must not be cached, or the server needs a restart once the DB is up.
    p.catch(() => instances.delete(db));
    instances.set(db, p);
  }
  return p;
}

/** Closes and forgets one database's connection; the next engineFor() reconnects. */
export async function closeEngine(db: string): Promise<void> {
  const p = instances.get(db);
  instances.delete(db);
  await (await p?.catch(() => null))?.close().catch(() => {});
}

export async function closeAll(): Promise<void> {
  for (const p of instances.values()) await (await p.catch(() => null))?.close().catch(() => {});
  instances.clear();
}
