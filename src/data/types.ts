export type Row = Record<string, string | null>;
export type Column = {
  name: string; type: string; nullable: boolean; defaultValue: string | null;
  extra: string; columnKey: string; expression: string; binary: boolean; generated: boolean;
};
export type Table = { name: string; kind: string };
export type TableIndex = {
  name: string; unique: boolean; primary: boolean; type: string;
  parts: { name: string | null; expression: string | null; direction: string; prefix: string | null; collation: string | null }[];
  details: string; sql: string | null; removable: boolean; reason: string;
};
export type ForeignKey = {
  name: string; database: string | null; table: string; columns: string[];
  referencedDatabase: string | null; referencedTable: string; referencedColumns: (string | null)[];
  onUpdate: string; onDelete: string;
};
export type Structure = { columns: Column[]; key: string[]; kind: string; sql?: string; indexes?: TableIndex[]; foreignKeys?: ForeignKey[]; referencedBy?: ForeignKey[] };
export type RowRef = { key: Row; version: string };
export type LargeFields = Record<string, { length: number }>;
export type Page = Structure & { rows: Row[]; rowRefs?: RowRef[]; truncated?: LargeFields[]; total: string; offset: number; limit: number };
export type QueryResult = { sets: { columns: string[]; rows: (string | null)[][]; affected: number; truncated: boolean; summary?: string }[]; elapsedMs: number; resultsTruncated?: boolean };
export type Definition = {
  name: string; type: string; length: string; scale: string; unsigned: boolean;
  nullable: boolean; primary: boolean; autoIncrement: boolean;
  defaultMode: 'none' | 'null' | 'value' | 'current_timestamp'; defaultValue: string;
};
export const columnTypes = ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'CHAR', 'VARCHAR', 'TEXT', 'LONGTEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON', 'BLOB'];
export const postgresColumnTypes = ['SMALLINT', 'INTEGER', 'BIGINT', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'BOOLEAN', 'TEXT', 'VARCHAR', 'CHAR', 'DATE', 'TIMESTAMP', 'JSONB', 'UUID', 'BYTEA'];
export function newColumn(name = '', sqlite = false): Definition {
  return { name, type: 'VARCHAR', length: '255', scale: '2', unsigned: false, nullable: sqlite, primary: false, autoIncrement: false, defaultMode: 'none', defaultValue: '' };
}
export function fromColumn(c: Column, postgres = false): Definition {
  const parts = /^(\w+)(?:\((\d+)(?:,(\d+))?\))?/i.exec(c.type);
  const numbers = /(\d+)\s*(?:,\s*(\d+))?/.exec(c.type);
  const current = /^current_timestamp(?:\(\d*\))?$/i.test(c.defaultValue ?? '');
  const mapped = postgres ? postgresFormType(c.type) : null;
  return {
    ...newColumn(c.name),
    type: mapped ?? parts?.[1].toUpperCase() ?? c.type,
    length: (postgres ? numbers?.[1] : parts?.[2]) ?? '255',
    scale: (postgres ? numbers?.[2] : parts?.[3]) ?? '2',
    unsigned: /unsigned/i.test(c.type),
    nullable: c.nullable,
    primary: c.columnKey === 'PRI',
    autoIncrement: /auto_increment|identity/i.test(c.extra),
    defaultMode: current ? 'current_timestamp' : c.defaultValue === null ? (c.nullable ? 'null' : 'none') : 'value',
    defaultValue: c.defaultValue ?? '',
  };
}
function postgresFormType(raw: string): string | null {
  const type = raw.trim().toLowerCase();
  if (type.startsWith('double precision')) return 'DOUBLE PRECISION';
  if (type.startsWith('character varying') || type.startsWith('varchar')) return 'VARCHAR';
  if (type === 'character' || type.startsWith('character(') || type === 'char' || type.startsWith('char(')) return 'CHAR';
  if (type.startsWith('timestamp')) return 'TIMESTAMP';
  if (type === 'integer' || type === 'int' || type === 'int4') return 'INTEGER';
  if (type === 'bigint' || type === 'int8') return 'BIGINT';
  if (type === 'smallint' || type === 'int2') return 'SMALLINT';
  if (type.startsWith('numeric') || type.startsWith('decimal')) return 'NUMERIC';
  if (type === 'real' || type === 'float4') return 'REAL';
  if (type === 'boolean' || type === 'bool') return 'BOOLEAN';
  if (type === 'text') return 'TEXT';
  if (type === 'date') return 'DATE';
  if (type === 'jsonb' || type === 'json') return 'JSONB';
  if (type === 'uuid') return 'UUID';
  if (type === 'bytea') return 'BYTEA';
  return null;
}
// Preserve advanced definitions by directing their edits to SQL instead of silently losing attributes.
export function editableColumn(c: Column, postgres = false): boolean {
  if (c.generated || /identity/i.test(c.extra)) return false;
  if (postgres && c.defaultValue && /[():]/.test(c.defaultValue) && !/^current_timestamp/i.test(c.defaultValue)) return false;
  const definition = fromColumn(c, postgres);
  const allowed = postgres ? postgresColumnTypes : columnTypes;
  return allowed.includes(definition.type) && !/on update|invisible|zerofill/i.test(`${c.type} ${c.extra}`) && (!/DEFAULT_GENERATED/i.test(c.extra) || definition.defaultMode === 'current_timestamp') && (postgres || !/\(\d+\)/.test(c.type.replace(/^(?:varchar|char|decimal)\([^)]*\)/i, '')));
}
