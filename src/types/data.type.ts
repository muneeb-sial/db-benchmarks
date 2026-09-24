import type { SuiteConfig } from './config.type.ts';

export interface Block {
  limit: number;
  start: number;
  end: number;
}

export interface DataPlan {
  cfg: SuiteConfig;
  seed: number;
  blocks: Block[];
  users: number;
  posts: number;
  likes: number;
  documents: number;
}
