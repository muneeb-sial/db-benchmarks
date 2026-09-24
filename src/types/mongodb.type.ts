import type { SuiteTable } from './schema.type.ts';
import type { Document } from 'mongodb';

export type Plan =
  | {
      type: 'find';
      table: SuiteTable;
      filter: Document;
      sort: Document;
      skip: number;
      limit: number;
      projection?: Document;
    }
  | { type: 'agg'; table: SuiteTable; pipeline: Document[] };
