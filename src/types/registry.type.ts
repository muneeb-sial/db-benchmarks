import type { Adapter, ConnectOptions } from './adapter.type.ts';

export interface EngineDescriptor {
  /** Default connection settings, matching that engine's docker-compose.yml. */
  defaults: ConnectOptions;
  load: () => Promise<Adapter>;
}
