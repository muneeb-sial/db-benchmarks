import type postgres from 'postgres';
import type { Runtime } from './runtime.type.ts';

export interface PgFamilyOptions {
  engine?: string;
  displayName?: string;
  supportedRuntimes?: readonly Runtime[];
  /**
   * How to read the server version. CockroachDB's `server_version` reports the
   * Postgres compatibility level it advertises (13.0.0), not its own version,
   * so it substitutes `select version()`.
   */
  versionQuery?: (sql: postgres.Sql) => Promise<string>;
  /** Which SQL dialect the suite renders for. */
  dialect?: 'postgres' | 'cockroachdb';
}
