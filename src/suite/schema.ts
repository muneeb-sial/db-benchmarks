import type { ColumnDef, SuiteRow, SuiteTable } from '../types/schema.type.ts';

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
