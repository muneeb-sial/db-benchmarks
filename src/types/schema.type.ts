export type SuiteTable =
  | 'users'
  | 'posts'
  | 'likes'
  | 'documents'
  | 'w_plain'
  | 'w_uk'
  | 'w_docs';

export type ColType = 'int' | 'varchar' | 'text' | 'timestamp' | 'json';

export interface ColumnDef {
  name: string;
  type: ColType;
  pk?: boolean;
  unique?: boolean;
}

export type SuiteRow = Record<string, unknown>;
