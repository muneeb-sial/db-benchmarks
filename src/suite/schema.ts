/**
 * Logical schema for the suite, independent of any engine.
 *
 * The suite has its own tables (default prefix `suite_`), recreated on every run.
 *
 *   users      email is the unique key; created_at is indexed after load;
 *              score is deliberately NON-indexed (R3, R7, R8); name and bio are
 *              the text-search targets (R9)
 *   posts      belongs to a user; views is the numeric column for SUM (R7)
 *   likes      belongs to a post and a user
 *   documents  one JSON document per row (R10)
 *   w_plain    scratch table for W1/W3: no unique key
 *   w_uk       scratch table for W2: email is unique
 *   w_docs     scratch table for W4: JSON inserts
 */

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

const USER_COLUMNS: ColumnDef[] = [
  { name: 'id', type: 'int', pk: true },
  { name: 'email', type: 'varchar', unique: true },
  { name: 'name', type: 'varchar' },
  { name: 'score', type: 'int' },
  { name: 'created_at', type: 'timestamp' },
  { name: 'bio', type: 'text' },
];

const withoutUnique = (cols: ColumnDef[]): ColumnDef[] =>
  cols.map((c) => (c.unique ? { name: c.name, type: c.type } : c));

const DOC_COLUMNS: ColumnDef[] = [
  { name: 'id', type: 'int', pk: true },
  { name: 'doc', type: 'json' },
];

export const TABLES: Record<SuiteTable, ColumnDef[]> = {
  users: USER_COLUMNS,
  posts: [
    { name: 'id', type: 'int', pk: true },
    { name: 'user_id', type: 'int' },
    { name: 'title', type: 'varchar' },
    { name: 'views', type: 'int' },
    { name: 'created_at', type: 'timestamp' },
  ],
  likes: [
    { name: 'id', type: 'int', pk: true },
    { name: 'post_id', type: 'int' },
    { name: 'user_id', type: 'int' },
    { name: 'created_at', type: 'timestamp' },
  ],
  documents: DOC_COLUMNS,
  w_plain: withoutUnique(USER_COLUMNS),
  w_uk: USER_COLUMNS,
  w_docs: DOC_COLUMNS,
};

export const ALL_TABLES: readonly SuiteTable[] = [
  'likes',
  'posts',
  'users',
  'documents',
  'w_plain',
  'w_uk',
  'w_docs',
];

export const columnNames = (table: SuiteTable): string[] => TABLES[table].map((c) => c.name);

/** Row object to positional array, in the table's column order. JSON stays an object. */
export function rowToArray(table: SuiteTable, row: SuiteRow): unknown[] {
  return TABLES[table].map((c) => row[c.name]);
}
