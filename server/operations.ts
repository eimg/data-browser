import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fork, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { QueryResult } from 'pg';
import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { ConnectionError, type Engine } from '../src/shared/connection';
import { releasePostgresDatabase, usePostgresDatabase, type OpenConnection } from './open';
import { assertIdent, pgTable, quoteIdent, quoteLiteral, splitStatements, userCatalog } from './sql';

type SqlValue = string | null;
type Grid = Record<string, SqlValue>;
type Column = {
  name: string; type: string; nullable: boolean; defaultValue: string | null;
  extra: string; columnKey: string; expression: string; binary: boolean; generated: boolean;
};
type IndexPart = { name: string | null; expression: string | null; direction: string; prefix: string | null; collation: string | null };
type TableIndex = {
  name: string; unique: boolean; primary: boolean; type: string; parts: IndexPart[];
  details: string; sql: string | null; removable: boolean; reason: string;
};
type ForeignKey = {
  name: string; database: string | null; table: string; columns: string[];
  referencedDatabase: string | null; referencedTable: string; referencedColumns: (string | null)[];
  onUpdate: string; onDelete: string;
};
type Request = Record<string, unknown>;

const backups = () => join(homedir(), '.data-browser', 'backups');
export type BackupKind = 'sqlite' | 'sql' | 'other';
export type BackupFile = { name: string; path: string; kind: BackupKind; bytes: number; modified: string };

export async function listBackupFiles(dir: string): Promise<{ files: BackupFile[]; truncated: boolean }> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: BackupFile[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    const path = join(dir, entry.name);
    let info;
    try { info = await stat(path); } catch { continue; }
    if (!info.isFile()) continue;
    const lower = entry.name.toLowerCase();
    const kind: BackupKind = lower.endsWith('.sqlite') ? 'sqlite' : lower.endsWith('.sql') ? 'sql' : 'other';
    files.push({ name: entry.name, path, kind, bytes: info.size, modified: info.mtime.toISOString() });
  }
  files.sort((a, b) => b.modified.localeCompare(a.modified) || a.name.localeCompare(b.name));
  return { files: files.slice(0, 200), truncated: files.length > 200 };
}
const sqliteWorker = fileURLToPath(new URL('./sqlite-query.mjs', import.meta.url));

function cell(value: unknown): SqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Buffer.isBuffer(value)) return `0x${value.toString('hex')}`;
  if (value instanceof Uint8Array) return `0x${Buffer.from(value).toString('hex')}`;
  return String(value);
}

function grid(row: Record<string, unknown>): Grid {
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, cell(value)]));
}

function canceled(): never {
  throw new ConnectionError('Canceled');
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new ConnectionError(`${label} is required`);
  return value;
}

export async function runOperation(connection: OpenConnection | null, request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) canceled();
  const started = Date.now();
  const op = text(request.op, 'Operation');
  if (op === 'open_backups') return { ...(await openBackups()), elapsedMs: Date.now() - started };
  if (op === 'list_backups') return { ...(await listBackups()), elapsedMs: Date.now() - started };
  if (!connection) throw new ConnectionError('Connect to a database first.');
  if (request.driver !== connection.engine) throw new ConnectionError('That data source is not connected.');
  if (connection.engine === 'sqlite' && request.path !== connection.database) throw new ConnectionError('Open the SQLite file again before browsing it.');
  try {
    const result = await dispatch(connection, request, signal);
    return { ...result, elapsedMs: Date.now() - started };
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    const message = error instanceof Error ? error.message : 'Could not complete that request';
    throw new ConnectionError(message.replace(/\bpassword=[^\s]*/gi, 'password=(hidden)'));
  }
}

async function dispatch(connection: OpenConnection, request: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  const engine = connection.engine;
  if (request.op === 'backup') {
    if (engine !== 'sqlite') throw new ConnectionError('This backup action is for the open SQLite file.');
    const file = await backupSqlite(connection);
    return { message: `SQLite backup saved to ${file}` };
  }
  if (request.op === 'databases') return { databases: await databases(connection) };
  const catalog = engine === 'sqlite' ? connection.database : userCatalog(engine, request.database);
  if (request.op === 'create_database') {
    await createCatalog(connection, catalog);
    return { message: 'Database created.' };
  }
  if (request.op === 'rename_database' || request.op === 'drop_database') await focusDatabase(connection, catalog);
  if (request.op === 'rename_database') return renameCatalog(connection, catalog, userCatalog(engine, request.name));
  if (request.op === 'drop_database') {
    const file = await protect(connection, catalog);
    await dropCatalog(connection, catalog);
    return { message: `Database deleted. A backup was saved to ${file}` };
  }
  await focusDatabase(connection, catalog);
  if (request.op === 'tables') return { tables: await tables(connection, catalog) };
  if (request.op === 'query') return query(connection, catalog, text(request.sql, 'SQL'), signal);
  if (request.op === 'export') {
    const file = await protect(connection, catalog, typeof request.table === 'string' ? (engine === 'postgres' ? assertPgTable(request.table) : assertIdent(request.table)) : undefined);
    return { message: `Export saved to ${file}` };
  }
  if (request.op === 'import') return importSql(connection, catalog, request);

  const table = engine === 'postgres' ? assertPgTable(request.table) : assertIdent(request.table, 'Table');
  if (request.op === 'create_table') {
    await createTable(connection, catalog, table, request.columns);
    return { message: 'Table created.' };
  }
  const columns = await tableColumns(connection, catalog, table);
  const map = new Map(columns.map(column => [column.name, column]));
  const links = await foreignKeys(connection, catalog, table);
  const indexes = await tableIndexes(connection, catalog, table, columns, links);
  const key = stableKey(columns, indexes);
  const kind = await tableKind(connection, catalog, table);
  if (request.op === 'structure') {
    return { columns, key, kind, sql: await tableSql(connection, catalog, table), indexes, ...links };
  }
  if (request.op === 'rows') return rows(connection, catalog, table, columns, key, kind, request);
  if (request.op === 'cell') return cellValue(connection, catalog, table, columns, key, request);
  if (kind !== 'BASE TABLE') throw new ConnectionError('Views are read-only in forms. Use SQL for advanced changes.');
  if (request.op === 'create_index') return createIndex(connection, catalog, table, columns, request);
  if (request.op === 'rename_table') {
    const name = assertIdent(request.name, 'Table');
    await execute(connection, `ALTER TABLE ${qualified(connection, catalog, table)} RENAME TO ${quoteIdent(name, engine)}`);
    return { message: 'Table renamed.' };
  }
  if (request.op === 'drop_table' || request.op === 'drop_column' || request.op === 'drop_index' || request.op === 'change_column') {
    const file = await protect(connection, catalog);
    if (request.op === 'drop_table') await execute(connection, `DROP TABLE ${qualified(connection, catalog, table)}`);
    if (request.op === 'drop_column') await execute(connection, `ALTER TABLE ${qualified(connection, catalog, table)} DROP COLUMN ${quoteIdent(assertIdent(request.name), engine)}`);
    if (request.op === 'drop_index') await dropIndex(connection, catalog, table, indexes, request);
    if (request.op === 'change_column') await changeColumn(connection, catalog, table, map, request);
    const verb = request.op === 'drop_table' ? 'Table deleted.' : request.op === 'drop_column' ? 'Column deleted.' : request.op === 'drop_index' ? 'Index removed.' : 'Column saved.';
    return { message: `${verb} A backup was saved to ${file}` };
  }
  if (request.op === 'add_column') {
    await addColumn(connection, catalog, table, request);
    return { message: 'Column saved.' };
  }
  if (request.op === 'insert' || request.op === 'update' || request.op === 'delete') {
    return mutate(connection, catalog, table, columns, key, request);
  }
  throw new ConnectionError('Unknown database operation.');
}

function qualified(connection: OpenConnection, catalog: string, table: string): string {
  if (connection.engine === 'sqlite') return quoteIdent(table, 'sqlite');
  if (connection.engine === 'postgres') {
    const located = pgTable(table);
    return `${quoteIdent(located.schema, 'postgres')}.${quoteIdent(located.name, 'postgres')}`;
  }
  return `${quoteIdent(catalog, 'mysql')}.${quoteIdent(table, 'mysql')}`;
}

async function focusDatabase(connection: OpenConnection, catalog: string): Promise<void> {
  if (connection.engine === 'postgres') await usePostgresDatabase(connection, catalog);
}

function assertPgTable(value: unknown): string {
  if (typeof value !== 'string') throw new ConnectionError('Table is required');
  const located = pgTable(value);
  assertIdent(located.schema, 'Schema');
  assertIdent(located.name, 'Table');
  return located.schema === 'public' && !value.includes('.') ? located.name : `${located.schema}.${located.name}`;
}

async function databases(connection: OpenConnection): Promise<string[]> {
  if (connection.engine === 'sqlite') return [connection.database];
  if (connection.engine === 'postgres') {
    const rows = await select(connection, `SELECT datname AS name FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname`);
    return rows.map(row => row.name ?? '').filter(Boolean);
  }
  const rows = await select(connection, `SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('mysql', 'sys', 'information_schema', 'performance_schema') ORDER BY SCHEMA_NAME`);
  return rows.map(row => row.name ?? '').filter(Boolean);
}

async function tables(connection: OpenConnection, catalog: string): Promise<{ name: string; kind: string }[]> {
  if (connection.engine === 'sqlite') {
    const rows = await select(connection, `SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name`);
    return rows.map(row => ({ name: row.name ?? '', kind: row.type === 'view' ? 'VIEW' : 'BASE TABLE' }));
  }
  if (connection.engine === 'postgres') {
    const rows = await select(connection, `SELECT table_schema AS schema, table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_schema NOT LIKE 'pg_toast%' AND table_schema NOT LIKE 'pg_temp_%' ORDER BY table_schema, table_name`);
    return rows.map(row => ({ name: row.schema && row.schema !== 'public' ? `${row.schema}.${row.name}` : row.name ?? '', kind: row.kind === 'VIEW' ? 'VIEW' : 'BASE TABLE' }));
  }
  const rows = await select(connection, `SELECT table_name AS name, table_type AS kind FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`, [catalog]);
  return rows.map(row => ({ name: row.name ?? '', kind: row.kind === 'VIEW' ? 'VIEW' : 'BASE TABLE' }));
}

async function tableKind(connection: OpenConnection, catalog: string, table: string): Promise<string> {
  const found = (await tables(connection, catalog)).find(item => item.name === table);
  if (!found) throw new ConnectionError('This table no longer exists. Refresh the database.');
  return found.kind;
}

async function tableColumns(connection: OpenConnection, catalog: string, table: string): Promise<Column[]> {
  if (connection.engine === 'sqlite') {
    const rows = await select(connection, `PRAGMA table_info(${quoteIdent(table, 'sqlite')})`);
    if (!rows.length) throw new ConnectionError('This table no longer exists. Refresh the database.');
    return rows.map(row => {
      const type = (row.type ?? '').toUpperCase();
      const primary = row.pk !== '0' && row.pk !== null && row.pk !== '';
      const integerPrimary = primary && type === 'INTEGER';
      return {
        name: row.name ?? '', type: type || 'NUMERIC', nullable: row.notnull !== '1' && !integerPrimary, defaultValue: row.dflt_value ?? null,
        extra: primary && type === 'INTEGER' ? 'autoincrement' : '', columnKey: primary ? 'PRI' : '', expression: '',
        binary: /BLOB|BINARY/i.test(type), generated: false,
      };
    });
  }
  if (connection.engine === 'postgres') return postgresColumns(connection, catalog, table);
  const rows = await select(connection, `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue, EXTRA AS extra, COLUMN_KEY AS columnKey, IFNULL(GENERATION_EXPRESSION, '') AS expression FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION`, [catalog, table]);
  if (!rows.length) throw new ConnectionError('This table no longer exists. Refresh the database.');
  return rows.map(row => ({
    name: row.name ?? '', type: row.type ?? '', nullable: row.nullable === 'YES', defaultValue: row.defaultValue ?? null,
    extra: row.extra ?? '', columnKey: row.columnKey ?? '', expression: row.expression ?? '',
    binary: /^(binary|varbinary|.*blob|bit|geometry|point|linestring|polygon)/i.test(row.type ?? ''),
    generated: (row.expression ?? '') !== '',
  }));
}

async function postgresColumns(connection: OpenConnection, _catalog: string, table: string): Promise<Column[]> {
  const located = pgTable(table);
  const rows = await select(connection, `SELECT column_name AS name, data_type AS type, udt_name AS udt, is_nullable AS nullable, column_default AS defaultValue, character_maximum_length AS length, numeric_precision AS precision, numeric_scale AS scale, is_identity AS identity, is_generated AS generated, generation_expression AS expression FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position`, [located.schema, located.name]);
  if (!rows.length) throw new ConnectionError('This table no longer exists. Refresh the database.');
  const keys = await select(connection, `SELECT k.column_name AS name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k ON k.constraint_schema = t.constraint_schema AND k.constraint_name = t.constraint_name AND k.table_name = t.table_name WHERE t.table_schema = ? AND t.table_name = ? AND t.constraint_type = 'PRIMARY KEY'`, [located.schema, located.name]);
  const primary = new Set(keys.map(row => row.name));
  return rows.map(row => {
    const udt = row.udt ?? '';
    let type = row.type ?? udt;
    if (row.length && (type === 'character varying' || type === 'character')) type = `${type === 'character' ? 'character' : 'character varying'}(${row.length})`;
    if (type === 'numeric' && row.precision) type = `numeric(${row.precision},${row.scale ?? '0'})`;
    const identity = row.identity === 'YES' || (row.defaultValue ?? '').startsWith('nextval(');
    return {
      name: row.name ?? '', type, nullable: row.nullable === 'YES', defaultValue: identity ? null : row.defaultValue ?? null,
      extra: identity ? 'identity' : '', columnKey: primary.has(row.name) ? 'PRI' : '', expression: row.generated === 'ALWAYS' ? row.expression ?? 'generated' : '',
      binary: udt === 'bytea', generated: row.generated === 'ALWAYS',
    };
  });
}

function displayExpr(engine: Engine, column: Column): string {
  const name = quoteIdent(column.name, engine);
  if (engine === 'mysql') return column.binary ? `CONCAT('0x', HEX(${name}))` : `CAST(${name} AS CHAR)`;
  if (engine === 'postgres') return column.binary ? `'0x' || encode(${name}, 'hex')` : `${name}::text`;
  return `CASE WHEN typeof(${name}) = 'blob' THEN '0x' || hex(${name}) ELSE CAST(${name} AS TEXT) END`;
}

async function rows(connection: OpenConnection, catalog: string, table: string, columns: Column[], key: string[], kind: string, request: Request): Promise<Record<string, unknown>> {
  const preview = Math.max(1, Math.min(1024, Math.floor(8192 / Math.max(1, columns.length))));
  const limit = Math.max(1, Math.min(50, Number(request.limit ?? 50) || 50));
  const offset = Math.max(0, Math.min(10_000_000, Number(request.offset ?? 0) || 0));
  const sort = typeof request.sort === 'string' && columns.some(column => column.name === request.sort) ? request.sort : (key[0] ?? columns[0]?.name);
  if (!sort) throw new ConnectionError('This table has no columns.');
  const direction = request.direction === 'DESC' ? 'DESC' : 'ASC';
  const order = [sort, ...key.filter(name => name !== sort)].map(name => `${quoteIdent(name, connection.engine)} ${direction}`).join(', ');
  const from = qualified(connection, catalog, table);
  const totalRow = await select(connection, `SELECT COUNT(*) AS n FROM ${from}`);
  const pieces = columns.flatMap(column => {
    const value = displayExpr(connection.engine, column);
    const slice = connection.engine === 'postgres' ? `substring((${value}) from 1 for ${preview})` : connection.engine === 'mysql' ? `SUBSTRING(${value}, 1, ${preview})` : `substr(${value}, 1, ${preview})`;
    const length = connection.engine === 'sqlite' ? `length(${value})` : `char_length(${value})`;
    return [`${slice} AS ${quoteIdent(`v_${column.name}`, connection.engine)}`, `${length} AS ${quoteIdent(`n_${column.name}`, connection.engine)}`];
  });
  const version = versionExpr(connection.engine, columns);
  pieces.push(`${version} AS version_hash`);
  for (const name of key) pieces.push(`${displayExpr(connection.engine, columns.find(column => column.name === name)!)} AS ${quoteIdent(`k_${name}`, connection.engine)}`);
  const page = await select(connection, `SELECT ${pieces.join(', ')} FROM ${from} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`);
  const data: Grid[] = [];
  const rowRefs: { key: Grid; version: string }[] = [];
  const truncated: Record<string, { length: number }>[] = [];
  for (const row of page) {
    const item: Grid = {};
    const large: Record<string, { length: number }> = {};
    for (const column of columns) {
      item[column.name] = row[`v_${column.name}`] ?? null;
      const length = Number(row[`n_${column.name}`] ?? 0);
      if (length > preview) large[column.name] = { length };
    }
    const identity: Grid = {};
    for (const name of key) identity[name] = row[`k_${name}`] ?? null;
    data.push(item);
    rowRefs.push({ key: identity, version: row.version_hash ?? '' });
    truncated.push(large);
  }
  return { columns, key, kind, rows: data, rowRefs, truncated, total: totalRow[0]?.n ?? '0', offset, limit };
}

function versionExpr(engine: Engine, columns: Column[]): string {
  const parts = columns.map(column => {
    const value = displayExpr(engine, column);
    return engine === 'postgres'
      ? `CASE WHEN ${quoteIdent(column.name, engine)} IS NULL THEN 'N' ELSE 'V' || md5(${value}) END`
      : `CASE WHEN ${quoteIdent(column.name, engine)} IS NULL THEN 'N' ELSE CONCAT('V', ${engine === 'mysql' ? `SHA2(${value}, 256)` : `sha256(${value})`}) END`;
  });
  const joined = parts.join(engine === 'postgres' ? ` || chr(31) || ` : engine === 'mysql' ? `,` : ` || char(31) || `);
  if (engine === 'postgres') return `md5(${joined || `''`})`;
  if (engine === 'mysql') return `SHA2(CONCAT(${joined || `''`}), 256)`;
  return `sha256(${joined || `''`})`;
}

async function cellValue(connection: OpenConnection, catalog: string, table: string, columns: Column[], key: string[], request: Request): Promise<Record<string, unknown>> {
  const name = assertIdent(request.column, 'Column');
  const column = columns.find(item => item.name === name);
  const ref = request.rowRef;
  if (!column || !ref || typeof ref !== 'object') throw new ConnectionError('Refresh this row before reading its value.');
  const version = text((ref as { version?: unknown }).version, 'Row version');
  const identity = (ref as { key?: unknown }).key;
  if (!identity || typeof identity !== 'object') throw new ConnectionError('Refresh this row before reading its value.');
  const { where, params } = locator(connection.engine, key, identity as Grid);
  const offset = Math.max(0, Number(request.offset ?? 0) || 0);
  const length = 131072;
  const value = displayExpr(connection.engine, column);
  const slice = connection.engine === 'postgres'
    ? `substring((${value}) from ${offset + 1} for ${length})`
    : connection.engine === 'mysql' ? `SUBSTRING(${value}, ${offset + 1}, ${length})` : `substr(${value}, ${offset + 1}, ${length})`;
  const totalExpr = connection.engine === 'sqlite' ? `length(${value})` : `char_length(${value})`;
  const found = await select(connection, `SELECT ${slice} AS value, ${totalExpr} AS total FROM ${qualified(connection, catalog, table)} WHERE ${where} AND ${versionExpr(connection.engine, columns)} = ? LIMIT 1`, [...params, version]);
  if (!found[0]) throw new ConnectionError('This row changed or was deleted. Refresh before reading its value.');
  const total = Number(found[0].total ?? 0);
  const nextOffset = Math.min(total, offset + length);
  return { value: found[0].value, offset, nextOffset, total, complete: nextOffset >= total };
}

function locator(engine: Engine, key: string[], identity: Grid): { where: string; params: string[] } {
  if (!key.length) throw new ConnectionError('This table has no non-null primary or unique key. Use SQL for ambiguous edits.');
  const params: string[] = [];
  const where = key.map(name => {
    const value = identity[name];
    if (typeof value !== 'string') throw new ConnectionError('Refresh this row before changing it.');
    params.push(value);
    return `${quoteIdent(name, engine)} = ?`;
  }).join(' AND ');
  return { where, params };
}

async function query(connection: OpenConnection, catalog: string, sql: string, signal: AbortSignal): Promise<Record<string, unknown>> {
  const textSql = sql.trim();
  if (!textSql || Buffer.byteLength(textSql) > 1024 * 1024) throw new ConnectionError('Enter SQL up to 1 MiB.');
  const statements = splitStatements(textSql, connection.engine === 'sqlite');
  if (statements.length > 10) throw new ConnectionError('Run up to ten statements at a time.');
  const sets = [];
  for (const statement of statements) {
    if (signal.aborted) canceled();
    const verb = statement.match(/^[a-z]+/i)?.[0].toUpperCase() ?? '';
    const reading = ['SELECT', 'WITH', 'VALUES', 'TABLE', 'SHOW', 'PRAGMA', 'EXPLAIN', 'DESCRIBE', 'DESC'].includes(verb);
    if (!reading) {
      const affected = connection.engine === 'sqlite'
        ? (await sqliteStatement(connection.database, statement, [], false, signal)).changes ?? 0
        : await execute(connection, statement, [], catalog, signal);
      sets.push({ columns: [], rows: [], affected, truncated: false });
      continue;
    }
    const wrapped = ['SELECT', 'WITH', 'VALUES', 'TABLE'].includes(verb)
      ? `SELECT * FROM (${statement}) AS data_browser_page LIMIT 201`
      : statement;
    let page: Grid[];
    try {
      page = connection.engine === 'sqlite'
        ? await sqliteRows(connection.database, wrapped, signal)
        : await select(connection, wrapped, [], catalog, signal);
    } catch (error) {
      if (wrapped === statement || (error instanceof ConnectionError && error.message === 'Canceled')) throw error;
      page = connection.engine === 'sqlite'
        ? await sqliteRows(connection.database, statement, signal)
        : await select(connection, statement, [], catalog, signal);
    }
    const columns = Object.keys(page[0] ?? {});
    const truncated = page.length > 200;
    sets.push({
      columns,
      rows: page.slice(0, 200).map(row => columns.map(column => row[column] ?? null)),
      affected: 0,
      truncated,
    });
  }
  return { sets, resultsTruncated: false };
}

async function mutate(connection: OpenConnection, catalog: string, table: string, columns: Column[], key: string[], request: Request): Promise<Record<string, unknown>> {
  const values = request.values && typeof request.values === 'object' ? request.values as Record<string, unknown> : {};
  const writable = new Map(columns.filter(column => !column.generated && !column.binary).map(column => [column.name, column]));
  const entries = Object.entries(values);
  for (const [name, value] of entries) {
    if (!writable.has(name)) throw new ConnectionError('This column is read-only.');
    if (value !== null && typeof value !== 'string') throw new ConnectionError('Row values must be text or SQL NULL.');
  }
  const target = qualified(connection, catalog, table);
  if (request.op === 'insert') {
    if (!entries.length) throw new ConnectionError('Enter at least one value.');
    const names = entries.map(([name]) => quoteIdent(name, connection.engine));
    await execute(connection, `INSERT INTO ${target} (${names.join(', ')}) VALUES (${entries.map(() => '?').join(', ')})`, entries.map(([, value]) => value as string | null));
    return { message: 'Row inserted.' };
  }
  const ref = request.rowRef;
  if (!ref || typeof ref !== 'object') throw new ConnectionError('Refresh this row before changing it.');
  const version = text((ref as { version?: unknown }).version, 'Row version');
  const identity = (ref as { key?: unknown }).key;
  if (!identity || typeof identity !== 'object') throw new ConnectionError('Refresh this row before changing it.');
  const found = locator(connection.engine, key, identity as Grid);
  const live = await select(connection, `SELECT ${versionExpr(connection.engine, columns)} AS version_hash FROM ${target} WHERE ${found.where} LIMIT 2`, found.params);
  if (live.length !== 1 || live[0]?.version_hash !== version) throw new ConnectionError('This row changed or was deleted. Refresh before saving.');
  if (request.op === 'delete') {
    await execute(connection, `DELETE FROM ${target} WHERE ${found.where} AND ${versionExpr(connection.engine, columns)} = ?`, [...found.params, version]);
    return { message: 'Row deleted.' };
  }
  if (!entries.length) return { message: 'Row saved.' };
  const assignments = entries.map(([name]) => `${quoteIdent(name, connection.engine)} = ?`);
  await execute(connection, `UPDATE ${target} SET ${assignments.join(', ')} WHERE ${found.where} AND ${versionExpr(connection.engine, columns)} = ?`, [...entries.map(([, value]) => value as string | null), ...found.params, version]);
  return { message: 'Row saved.' };
}

async function createCatalog(connection: OpenConnection, name: string): Promise<void> {
  if (connection.engine === 'sqlite') throw new ConnectionError('SQLite keeps its data in the open file. Create a table instead.');
  if (connection.engine === 'postgres') {
    if (connection.database !== connection.maintenance) connection.database = connection.maintenance;
    await execute(connection, `CREATE DATABASE ${quoteIdent(name, 'postgres')}`);
    return;
  }
  await execute(connection, `CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
}

async function dropCatalog(connection: OpenConnection, name: string): Promise<void> {
  if (connection.engine === 'postgres') {
    if (name === connection.maintenance) throw new ConnectionError('This database is the one used to reach the server. Delete a different database.');
    await releasePostgresDatabase(connection, name);
    connection.database = connection.maintenance;
    await execute(connection, `DROP DATABASE ${quoteIdent(name, 'postgres')}`);
    return;
  }
  await execute(connection, `DROP DATABASE ${quoteIdent(name, 'mysql')}`);
}

async function renameCatalog(connection: OpenConnection, catalog: string, name: string): Promise<Record<string, unknown>> {
  if (connection.engine === 'sqlite') throw new ConnectionError('Rename tables inside the SQLite file. The file path stays where you opened it.');
  const existing = await tables(connection, catalog);
  if (existing.length) throw new ConnectionError('Only empty databases can be renamed. Export a populated database and import it into a new one.');
  if (connection.engine === 'postgres') {
    if (catalog === connection.maintenance) throw new ConnectionError('This database is the one used to reach the server. Rename a different database.');
    await releasePostgresDatabase(connection, catalog);
    connection.database = connection.maintenance;
    await execute(connection, `ALTER DATABASE ${quoteIdent(catalog, 'postgres')} RENAME TO ${quoteIdent(name, 'postgres')}`);
  } else {
    await execute(connection, `CREATE DATABASE ${quoteIdent(name, 'mysql')} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await execute(connection, `DROP DATABASE ${quoteIdent(catalog, 'mysql')}`);
  }
  return { message: 'Database renamed. Update the connection if an application still uses the old name.' };
}

async function createTable(connection: OpenConnection, catalog: string, table: string, value: unknown): Promise<void> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100) throw new ConnectionError('Create a table with 1–100 columns.');
  const engine = connection.engine;
  const definitions: string[] = [];
  const primary: string[] = [];
  const seen = new Set<string>();
  let identity = 0;
  for (const column of value) {
    if (!column || typeof column !== 'object') throw new ConnectionError('Each column needs a definition.');
    const name = assertIdent((column as { name?: unknown }).name, 'Column');
    if (seen.has(name.toLowerCase())) throw new ConnectionError('Column names must be unique.');
    seen.add(name.toLowerCase());
    definitions.push(columnSql(engine, column as Record<string, unknown>));
    if ((column as { primary?: unknown }).primary === true) primary.push(quoteIdent(name, engine));
    if ((column as { autoIncrement?: unknown }).autoIncrement === true) identity++;
  }
  if (identity > 1) throw new ConnectionError('Only one column can auto-increment.');
  if (primary.length && engine !== 'sqlite') definitions.push(`PRIMARY KEY (${primary.join(', ')})`);
  const prefix = engine === 'sqlite' ? '' : engine === 'postgres' ? `${quoteIdent('public', 'postgres')}.` : `${quoteIdent(catalog, engine)}.`;
  await execute(connection, `CREATE TABLE ${prefix}${quoteIdent(table, engine)} (${definitions.join(', ')})`);
}

function columnSql(engine: Engine, column: Record<string, unknown>): string {
  const name = quoteIdent(assertIdent(column.name, 'Column'), engine);
  const type = text(column.type, 'Column type').toUpperCase();
  const mysqlTypes = ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'DOUBLE', 'CHAR', 'VARCHAR', 'TEXT', 'LONGTEXT', 'BOOLEAN', 'DATE', 'DATETIME', 'TIMESTAMP', 'JSON', 'BLOB'];
  const postgresTypes = ['SMALLINT', 'INTEGER', 'BIGINT', 'NUMERIC', 'REAL', 'DOUBLE PRECISION', 'BOOLEAN', 'TEXT', 'VARCHAR', 'CHAR', 'DATE', 'TIMESTAMP', 'JSONB', 'UUID', 'BYTEA'];
  const sqliteTypes = ['INTEGER', 'TEXT', 'REAL', 'NUMERIC', 'BLOB'];
  const allowed = engine === 'postgres' ? postgresTypes : engine === 'sqlite' ? sqliteTypes : mysqlTypes;
  if (!allowed.includes(type)) throw new ConnectionError('Choose a supported column type.');
  let sql = `${name} ${type}`;
  if (['CHAR', 'VARCHAR'].includes(type)) {
    const length = Number(column.length);
    const max = type === 'CHAR' ? 255 : engine === 'postgres' ? 10485760 : 16383;
    if (!Number.isInteger(length) || length < 1 || length > max) throw new ConnectionError('Enter a valid character length.');
    sql += `(${length})`;
  }
  if (type === 'DECIMAL' || type === 'NUMERIC') {
    const precision = Number(column.length);
    const scale = Number(column.scale);
    const max = engine === 'mysql' ? 65 : 1000;
    if (!Number.isInteger(precision) || !Number.isInteger(scale) || precision < 1 || precision > max || scale < 0 || scale > Math.min(30, precision)) throw new ConnectionError('Choose a valid numeric precision and scale.');
    sql += `(${precision},${scale})`;
  }
  if (column.unsigned === true && engine === 'mysql' && ['INT', 'BIGINT', 'SMALLINT', 'TINYINT', 'DECIMAL', 'FLOAT', 'DOUBLE'].includes(type)) sql += ' UNSIGNED';
  const nullable = column.nullable === true && column.primary !== true && column.autoIncrement !== true;
  const mode = column.defaultMode ?? 'none';
  if (column.autoIncrement === true) {
    const integer = engine === 'sqlite' ? type === 'INTEGER' : engine === 'postgres' ? ['SMALLINT', 'INTEGER', 'BIGINT'].includes(type) : ['INT', 'BIGINT', 'SMALLINT', 'TINYINT'].includes(type);
    if (!integer || column.primary !== true || mode !== 'none') throw new ConnectionError('Auto-increment needs an integer primary key without a default.');
    if (engine === 'postgres') sql += ' GENERATED BY DEFAULT AS IDENTITY';
    if (engine === 'sqlite') sql += ' PRIMARY KEY AUTOINCREMENT';
  }
  sql += nullable ? ' NULL' : ' NOT NULL';
  if (mode === 'null') {
    if (!nullable) throw new ConnectionError('A NOT NULL column cannot default to NULL.');
    sql += ' DEFAULT NULL';
  } else if (mode === 'value') sql += ` DEFAULT ${quoteLiteral(typeof column.defaultValue === 'string' ? column.defaultValue : '')}`;
  else if (mode === 'current_timestamp') {
    if (engine === 'mysql' && !['TIMESTAMP', 'DATETIME'].includes(type)) throw new ConnectionError('CURRENT_TIMESTAMP is available for timestamp and datetime columns.');
    sql += ' DEFAULT CURRENT_TIMESTAMP';
  } else if (mode !== 'none') throw new ConnectionError('Unsupported default value.');
  if (column.autoIncrement === true && engine === 'mysql') sql += ' AUTO_INCREMENT';
  if (column.primary === true && engine === 'sqlite' && column.autoIncrement !== true) sql += ' PRIMARY KEY';
  return sql;
}

async function addColumn(connection: OpenConnection, catalog: string, table: string, request: Request): Promise<void> {
  const column = request.column;
  if (!column || typeof column !== 'object') throw new ConnectionError('Column definition is required.');
  const definition = columnSql(connection.engine, column as Record<string, unknown>);
  let sql = `ALTER TABLE ${qualified(connection, catalog, table)} ADD COLUMN ${definition}`;
  if ((column as { primary?: unknown }).primary === true && connection.engine !== 'sqlite') {
    sql += `, ADD PRIMARY KEY (${quoteIdent(assertIdent((column as { name?: unknown }).name), connection.engine)})`;
  }
  await execute(connection, sql);
}

async function changeColumn(connection: OpenConnection, catalog: string, table: string, map: Map<string, Column>, request: Request): Promise<void> {
  if (connection.engine === 'sqlite') throw new ConnectionError('Use SQL for SQLite column renames and type changes.');
  const column = request.column;
  if (!column || typeof column !== 'object') throw new ConnectionError('Column definition is required.');
  const previous = assertIdent(request.oldName, 'Column');
  if (!map.has(previous)) throw new ConnectionError('The original column no longer exists.');
  const definition = columnSql(connection.engine, column as Record<string, unknown>);
  const target = qualified(connection, catalog, table);
  if (connection.engine === 'mysql') await execute(connection, `ALTER TABLE ${target} CHANGE COLUMN ${quoteIdent(previous, 'mysql')} ${definition}`);
  else {
    const name = assertIdent((column as { name?: unknown }).name);
    const quoted = quoteIdent(name, 'postgres');
    if (name !== previous) await execute(connection, `ALTER TABLE ${target} RENAME COLUMN ${quoteIdent(previous, 'postgres')} TO ${quoted}`);
    await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} TYPE ${postgresTypeClause(definition, quoted)}`);
    const nullable = (column as { nullable?: unknown }).nullable === true && (column as { primary?: unknown }).primary !== true && (column as { autoIncrement?: unknown }).autoIncrement !== true;
    await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} ${nullable ? 'DROP NOT NULL' : 'SET NOT NULL'}`);
    const mode = (column as { defaultMode?: unknown }).defaultMode ?? 'none';
    if (mode === 'value') await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} SET DEFAULT ${quoteLiteral(typeof (column as { defaultValue?: unknown }).defaultValue === 'string' ? (column as { defaultValue: string }).defaultValue : '')}`);
    else if (mode === 'null') await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} SET DEFAULT NULL`);
    else if (mode === 'current_timestamp') await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} SET DEFAULT CURRENT_TIMESTAMP`);
    else await execute(connection, `ALTER TABLE ${target} ALTER COLUMN ${quoted} DROP DEFAULT`);
  }
}

function postgresTypeClause(definition: string, quotedName: string): string {
  let rest = definition.slice(quotedName.length).trim();
  rest = rest.replace(/\s+GENERATED\s+BY\s+DEFAULT\s+AS\s+IDENTITY\s*$/i, '');
  rest = rest.replace(/\s+DEFAULT\s+[\s\S]*$/i, '');
  rest = rest.replace(/\s+NOT\s+NULL\s*$/i, '');
  rest = rest.replace(/\s+NULL\s*$/i, '');
  if (!rest) throw new ConnectionError('Choose a supported column type.');
  return rest;
}

async function createIndex(connection: OpenConnection, catalog: string, table: string, columns: Column[], request: Request): Promise<Record<string, unknown>> {
  const name = assertIdent(request.name, 'Index');
  const selected = request.indexColumns;
  if (!Array.isArray(selected) || selected.length < 1 || selected.length > 16) throw new ConnectionError('Choose 1–16 index columns in order.');
  const seen = new Set<string>();
  const parts = selected.map(column => {
    if (typeof column !== 'string' || !columns.some(item => item.name === column) || seen.has(column.toLowerCase())) throw new ConnectionError('Choose existing, distinct index columns.');
    seen.add(column.toLowerCase());
    return quoteIdent(column, connection.engine);
  });
  const unique = request.unique === true ? 'UNIQUE ' : '';
  await execute(connection, `CREATE ${unique}INDEX ${quoteIdent(name, connection.engine)} ON ${qualified(connection, catalog, table)} (${parts.join(', ')})`);
  return { message: request.unique === true ? 'Unique index created.' : 'Index created.' };
}

async function dropIndex(connection: OpenConnection, catalog: string, table: string, indexes: TableIndex[], request: Request): Promise<void> {
  const name = assertIdent(request.name, 'Index');
  const index = indexes.find(item => item.name === name);
  if (!index?.removable) throw new ConnectionError(index?.reason || 'This index changed or was removed. Refresh before trying again.');
  if (connection.engine === 'mysql') await execute(connection, `DROP INDEX ${quoteIdent(name, 'mysql')} ON ${qualified(connection, catalog, table)}`);
  else if (connection.engine === 'postgres') await execute(connection, `DROP INDEX ${quoteIdent(pgTable(table).schema, 'postgres')}.${quoteIdent(name, 'postgres')}`);
  else await execute(connection, `DROP INDEX ${quoteIdent(name, 'sqlite')}`);
}

function stableKey(columns: Column[], indexes: TableIndex[]): string[] {
  const primary = columns.filter(column => column.columnKey === 'PRI');
  if (primary.length && primary.every(column => !column.nullable && !column.binary)) return primary.map(column => column.name);
  const ranked = [...indexes].sort((left, right) => Number(right.primary) - Number(left.primary));
  for (const index of ranked) {
    if (!index.unique && !index.primary) continue;
    const names = index.parts.map(part => part.name);
    if (names.some(name => !name)) continue;
    const chosen = names.map(name => columns.find(column => column.name === name));
    if (chosen.every(column => column && !column.nullable && !column.binary)) return names as string[];
  }
  return [];
}

async function tableIndexes(connection: OpenConnection, catalog: string, table: string, columns: Column[], links: { foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }): Promise<TableIndex[]> {
  if (connection.engine === 'sqlite') return sqliteIndexes(connection, table, columns, links);
  if (connection.engine === 'postgres') return postgresIndexes(connection, catalog, table, columns, links);
  const rows = await select(connection, `SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique, COLUMN_NAME AS col, COLLATION AS direction, SUB_PART AS prefix, INDEX_TYPE AS type FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX`, [catalog, table]);
  const groups = new Map<string, TableIndex>();
  for (const row of rows) {
    const name = row.name ?? '';
    let index = groups.get(name);
    if (!index) {
      index = { name, unique: row.nonUnique === '0', primary: name === 'PRIMARY', type: row.type ?? 'BTREE', parts: [], details: '', sql: null, removable: true, reason: '' };
      groups.set(name, index);
    }
    index.parts.push({ name: row.col, expression: null, direction: row.direction === 'D' ? 'DESC' : 'ASC', prefix: row.prefix, collation: null });
    if (row.prefix) index.reason = 'Advanced index; manage it in SQL.';
  }
  return protectIndexes([...groups.values()], columns, links);
}

async function postgresIndexes(connection: OpenConnection, _catalog: string, table: string, columns: Column[], links: { foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }): Promise<TableIndex[]> {
  const located = pgTable(table);
  const rows = await select(connection, `SELECT ic.relname AS name, ix.indisunique AS "unique", ix.indisprimary AS "primary", am.amname AS type, pg_get_indexdef(ix.indexrelid) AS sql, (
    SELECT string_agg(COALESCE(a.attname, '(expression)'), ',' ORDER BY k.ord)
    FROM unnest(ix.indkey) WITH ORDINALITY AS k(attnum, ord)
    LEFT JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum AND k.attnum > 0
  ) AS columns
  FROM pg_index ix
  JOIN pg_class t ON t.oid = ix.indrelid
  JOIN pg_class ic ON ic.oid = ix.indexrelid
  JOIN pg_namespace n ON n.oid = t.relnamespace
  JOIN pg_am am ON am.oid = ic.relam
  WHERE n.nspname = ? AND t.relname = ?
  ORDER BY ix.indisprimary DESC, ic.relname`, [located.schema, located.name]);
  return protectIndexes(rows.map(row => ({
    name: row.name ?? '',
    unique: row.unique === 'true' || row.unique === 't',
    primary: row.primary === 'true' || row.primary === 't',
    type: row.type ?? 'btree',
    parts: (row.columns ?? '').split(',').filter(Boolean).map(name => ({ name: name === '(expression)' ? null : name, expression: name === '(expression)' ? name : null, direction: 'ASC', prefix: null, collation: null })),
    details: '',
    sql: row.sql,
    removable: true,
    reason: (row.columns ?? '').includes('(expression)') ? 'Advanced index; manage it in SQL.' : '',
  })), columns, links);
}

async function sqliteIndexes(connection: OpenConnection, table: string, columns: Column[], links: { foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }): Promise<TableIndex[]> {
  const listed = await select(connection, `PRAGMA index_list(${quoteIdent(table, 'sqlite')})`);
  const indexes: TableIndex[] = [];
  for (const row of listed) {
    const name = row.name ?? '';
    const info = name ? await select(connection, `PRAGMA index_info(${quoteIdent(name, 'sqlite')})`) : [];
    const primary = row.origin === 'pk';
    indexes.push({
      name: name || 'PRIMARY',
      unique: row.unique === '1' || primary,
      primary,
      type: 'sqlite',
      parts: info.map(part => ({ name: part.name, expression: null, direction: 'ASC', prefix: null, collation: null })),
      details: '',
      sql: null,
      removable: !primary && !name.startsWith('sqlite_autoindex'),
      reason: primary || name.startsWith('sqlite_autoindex') ? 'Primary key; manage it in SQL.' : '',
    });
  }
  const rowid = columns.filter(column => column.columnKey === 'PRI' && column.type === 'INTEGER');
  if (rowid.length && !indexes.some(index => index.primary)) {
    indexes.unshift({
      name: 'rowid',
      unique: true,
      primary: true,
      type: 'rowid',
      parts: rowid.map(column => ({ name: column.name, expression: null, direction: 'ASC', prefix: null, collation: null })),
      details: 'INTEGER PRIMARY KEY is the SQLite rowid. It has no separate index.',
      sql: null,
      removable: false,
      reason: 'Primary key; manage it in SQL.',
    });
  }
  return protectIndexes(indexes, columns, links);
}

function protectIndexes(indexes: TableIndex[], columns: Column[], links: { foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }): TableIndex[] {
  for (const index of indexes) {
    if (index.primary) index.reason = index.reason || 'Primary key; manage it in SQL.';
    const names = index.parts.map(part => (part.name ?? '').toLowerCase());
    for (const column of columns) if (/auto_increment|identity|autoincrement/i.test(column.extra) && names[0] === column.name.toLowerCase()) index.reason = 'Supports an automatic ID; manage it in SQL.';
    for (const key of [...links.foreignKeys, ...links.referencedBy]) {
      const fields = links.foreignKeys.includes(key) ? key.columns : key.referencedColumns;
      if (fields.length && names.slice(0, fields.length).join() === fields.map(name => (name ?? '').toLowerCase()).join()) index.reason = 'Supports a foreign key; manage it in SQL.';
    }
    index.removable = index.reason === '';
  }
  return indexes;
}

async function foreignKeys(connection: OpenConnection, catalog: string, table: string): Promise<{ foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }> {
  if (connection.engine === 'sqlite') return sqliteForeignKeys(connection, table);
  if (connection.engine === 'postgres') return postgresForeignKeys(connection, catalog, table);
  const rows = await select(connection, `SELECT k.CONSTRAINT_NAME AS name, k.TABLE_SCHEMA AS db, k.TABLE_NAME AS tbl, k.COLUMN_NAME AS col, k.REFERENCED_TABLE_SCHEMA AS refDb, k.REFERENCED_TABLE_NAME AS refTable, k.REFERENCED_COLUMN_NAME AS refCol, r.UPDATE_RULE AS onUpdate, r.DELETE_RULE AS onDelete
    FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.TABLE_NAME = k.TABLE_NAME AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
    WHERE (k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ?) OR (k.REFERENCED_TABLE_SCHEMA = ? AND k.REFERENCED_TABLE_NAME = ?)
    ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, [catalog, table, catalog, table]);
  return groupForeignKeys(rows, catalog, table);
}

async function postgresForeignKeys(connection: OpenConnection, _catalog: string, table: string): Promise<{ foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }> {
  const located = pgTable(table);
  const rows = await select(connection, `SELECT con.conname AS name, child_ns.nspname AS db, child.relname AS tbl, parent_ns.nspname AS refDb, parent.relname AS refTable,
    (SELECT string_agg(a.attname, ',' ORDER BY key.ord) FROM unnest(con.conkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute a ON a.attrelid = child.oid AND a.attnum = key.attnum) AS cols,
    (SELECT string_agg(a.attname, ',' ORDER BY key.ord) FROM unnest(con.confkey) WITH ORDINALITY AS key(attnum, ord) JOIN pg_attribute a ON a.attrelid = parent.oid AND a.attnum = key.attnum) AS refCols,
    con.confupdtype AS onUpdate, con.confdeltype AS onDelete
    FROM pg_constraint con
    JOIN pg_class child ON child.oid = con.conrelid
    JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
    WHERE con.contype = 'f' AND ((child_ns.nspname = ? AND child.relname = ?) OR (parent_ns.nspname = ? AND parent.relname = ?))`, [located.schema, located.name, located.schema, located.name]);
  const rules: Record<string, string> = { a: 'NO ACTION', r: 'RESTRICT', c: 'CASCADE', n: 'SET NULL', d: 'SET DEFAULT' };
  const expanded = rows.flatMap(row => {
    const columns = (row.cols ?? '').split(',').filter(Boolean);
    const referenced = (row.refCols ?? '').split(',').filter(Boolean);
    return columns.map((column, index) => ({ ...row, col: column, refCol: referenced[index] ?? null, onUpdate: rules[row.onUpdate ?? ''] ?? row.onUpdate, onDelete: rules[row.onDelete ?? ''] ?? row.onDelete }));
  });
  return groupForeignKeys(expanded, located.schema, located.name);
}

async function sqliteForeignKeys(connection: OpenConnection, table: string): Promise<{ foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] }> {
  const outgoing = await sqliteForeignKeyList(connection, table);
  const tables = await select(connection, `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`);
  const incoming: Grid[] = [];
  for (const item of tables) {
    if (!item.name || item.name === table) continue;
    const keys = await sqliteForeignKeyList(connection, item.name);
    incoming.push(...keys.filter(key => key.refTable === table).map(key => ({ ...key, tbl: item.name, db: null })));
  }
  return {
    foreignKeys: groupForeignKeys(outgoing.map(key => ({ ...key, tbl: table, db: null })), '', table).foreignKeys,
    referencedBy: groupForeignKeys(incoming, '', table).referencedBy,
  };
}

async function sqliteForeignKeyList(connection: OpenConnection, table: string): Promise<Grid[]> {
  const rows = await select(connection, `PRAGMA foreign_key_list(${quoteIdent(table, 'sqlite')})`);
  return rows.map(row => ({ name: row.id ?? 'fk', db: null, tbl: table, col: row.from, refDb: null, refTable: row.table, refCol: row.to, onUpdate: (row.on_update ?? 'NO ACTION').toUpperCase(), onDelete: (row.on_delete ?? 'NO ACTION').toUpperCase() }));
}

function groupForeignKeys(rows: Grid[], catalog: string, table: string): { foreignKeys: ForeignKey[]; referencedBy: ForeignKey[] } {
  const groups = new Map<string, ForeignKey>();
  for (const row of rows) {
    const id = `${row.db ?? ''}/${row.tbl ?? ''}/${row.name ?? ''}`;
    let key = groups.get(id);
    if (!key) {
      key = { name: row.name ?? '', database: row.db ?? null, table: row.tbl ?? '', columns: [], referencedDatabase: row.refDb ?? null, referencedTable: row.refTable ?? '', referencedColumns: [], onUpdate: row.onUpdate ?? '', onDelete: row.onDelete ?? '' };
      groups.set(id, key);
    }
    key.columns.push(row.col ?? '');
    key.referencedColumns.push(row.refCol ?? null);
  }
  const values = [...groups.values()];
  return {
    foreignKeys: values.filter(key => key.table === table && (key.database === catalog || key.database === null || catalog === '')),
    referencedBy: values.filter(key => key.referencedTable === table && key.table !== table),
  };
}

async function tableSql(connection: OpenConnection, catalog: string, table: string): Promise<string> {
  if (connection.engine === 'sqlite') {
    const rows = await select(connection, `SELECT sql FROM sqlite_master WHERE name = ?`, [table]);
    return rows[0]?.sql ?? '';
  }
  if (connection.engine === 'mysql') {
    const rows = await select(connection, `SHOW CREATE TABLE ${qualified(connection, catalog, table)}`);
    const row = rows[0] ?? {};
    return row['Create Table'] ?? row['Create View'] ?? Object.values(row)[1] ?? '';
  }
  const columns = await tableColumns(connection, catalog, table);
  const body = columns.map(column => `${quoteIdent(column.name, 'postgres')} ${column.type}${column.nullable ? '' : ' NOT NULL'}${column.defaultValue !== null ? ` DEFAULT ${column.defaultValue}` : ''}`).join(',\n  ');
  return `CREATE TABLE ${qualified(connection, catalog, table)} (\n  ${body}\n);`;
}

async function protect(connection: OpenConnection, catalog: string, onlyTable?: string): Promise<string> {
  await mkdir(backups(), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safe = catalog.replace(/[^\w.-]+/g, '_').slice(0, 40);
  if (connection.engine === 'sqlite') return backupSqlite(connection, `${safe}-${stamp}.sqlite`);
  const file = join(backups(), `${safe}${onlyTable ? `-${onlyTable}` : ''}-${stamp}.sql`);
  const names = onlyTable ? [onlyTable] : (await tables(connection, catalog)).filter(table => table.kind === 'BASE TABLE').map(table => table.name);
  const chunks: string[] = [`-- data-browser backup ${new Date().toISOString()}`, ''];
  for (const table of names) {
    const sql = await tableSql(connection, catalog, table);
    chunks.push(sql.endsWith(';') ? sql : `${sql};`, '');
    const data = await select(connection, `SELECT * FROM ${qualified(connection, catalog, table)}`);
    for (const row of data) {
      const columns = Object.keys(row);
      const values = columns.map(column => row[column] === null ? 'NULL' : quoteLiteral(row[column] ?? ''));
      chunks.push(`INSERT INTO ${qualified(connection, catalog, table)} (${columns.map(column => quoteIdent(column, connection.engine)).join(', ')}) VALUES (${values.join(', ')});`);
    }
    chunks.push('');
  }
  await writeFile(file, chunks.join('\n'), 'utf8');
  return file;
}

async function backupSqlite(connection: OpenConnection, filename?: string): Promise<string> {
  if (connection.engine !== 'sqlite') throw new ConnectionError('Open a SQLite file first.');
  await mkdir(backups(), { recursive: true });
  const file = join(backups(), filename ?? `${createHash('sha1').update(connection.database).digest('hex').slice(0, 8)}-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`);
  connection.sqlite.prepare(`VACUUM INTO ${quoteLiteral(file)}`).run();
  return file;
}

async function importSql(connection: OpenConnection, catalog: string, request: Request): Promise<Record<string, unknown>> {
  if (connection.engine === 'sqlite') throw new ConnectionError('SQLite is edited in the open file. Import is available for PostgreSQL and MySQL.');
  if (request.confirmed !== true) throw new ConnectionError('Type the database name to confirm the import.');
  const path = text(request.sqlFile, 'SQL file');
  const file = await protect(connection, catalog);
  const sql = await readFile(path, 'utf8');
  const statements = splitStatements(sql, false);
  for (const statement of statements) await execute(connection, statement, [], catalog);
  return { message: `Imported ${statements.length} statements. A backup was saved to ${file}` };
}

async function listBackups(): Promise<Record<string, unknown>> {
  const directory = backups();
  await mkdir(directory, { recursive: true });
  return { directory, ...(await listBackupFiles(directory)) };
}

async function openBackups(): Promise<Record<string, unknown>> {
  const dir = backups();
  await mkdir(dir, { recursive: true });
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  spawn(command, [dir], { detached: true, stdio: 'ignore' }).unref();
  return { message: `Backups folder: ${dir}` };
}

async function select(connection: OpenConnection, sql: string, params: unknown[] = [], catalog?: string, signal?: AbortSignal): Promise<Grid[]> {
  const textSql = bind(connection.engine, sql, params);
  if (signal?.aborted) canceled();
  if (connection.engine === 'sqlite') {
    return (connection.sqlite.prepare(textSql).all(...params) as Record<string, unknown>[]).map(grid);
  }
  if (connection.engine === 'postgres') {
    const result = await postgresQuery(connection, textSql, params, catalog, signal);
    return result.rows.map(row => grid(row));
  }
  const [rows] = await mysqlQuery(connection, textSql, params, catalog, signal);
  return (rows as RowDataPacket[]).map(row => grid(row));
}

async function execute(connection: OpenConnection, sql: string, params: unknown[] = [], catalog?: string, signal?: AbortSignal): Promise<number> {
  const textSql = bind(connection.engine, sql, params);
  if (signal?.aborted) canceled();
  if (connection.engine === 'sqlite') return connection.sqlite.prepare(textSql).run(...params).changes;
  if (connection.engine === 'postgres') return (await postgresQuery(connection, textSql, params, catalog, signal)).rowCount ?? 0;
  const [result] = await mysqlQuery(connection, textSql, params, catalog, signal);
  return (result as ResultSetHeader).affectedRows ?? 0;
}

function sqliteRows(path: string, sql: string, signal: AbortSignal): Promise<Grid[]> {
  return sqliteStatement(path, sql, [], true, signal).then(result => (result.rows ?? []).map(row => grid(row)));
}

function sqliteStatement(path: string, sql: string, params: unknown[], read: boolean, signal: AbortSignal): Promise<{ rows?: Record<string, unknown>[]; changes?: number }> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ConnectionError('Canceled'));
      return;
    }
    const child = fork(sqliteWorker, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    let settled = false;
    const timer = setTimeout(() => stop(new ConnectionError('Query stopped after 30 seconds.')), 30_000);
    const stop = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      reject(error);
    };
    const onAbort = () => stop(new ConnectionError('Canceled'));
    signal.addEventListener('abort', onAbort, { once: true });
    child.once('message', (message: { ok?: boolean; rows?: Record<string, unknown>[]; changes?: number; message?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      child.kill('SIGKILL');
      if (message?.ok) resolve(message);
      else reject(new ConnectionError(message?.message || 'SQLite query failed'));
    });
    child.once('error', error => stop(error));
    child.once('exit', () => {
      if (!settled) stop(signal.aborted ? new ConnectionError('Canceled') : new ConnectionError('SQLite query stopped.'));
    });
    child.send({ path, sql, params, read });
  });
}

function bind(engine: Engine, sql: string, params: unknown[]): string {
  if (engine !== 'postgres' || params.length === 0) return sql;
  let index = 0;
  return sql.replaceAll('?', () => `$${++index}`);
}

async function postgresQuery(connection: Extract<OpenConnection, { engine: 'postgres' }>, sql: string, params: unknown[], _catalog?: string, signal?: AbortSignal): Promise<QueryResult> {
  const pool = connection.pools.get(connection.database);
  if (!pool) throw new ConnectionError('The PostgreSQL connection is closed.');
  const client = await pool.connect();
  let cancel: (() => void) | undefined;
  try {
    if (signal?.aborted) canceled();
    if (signal) {
      const pid = await client.query<{ pid: string }>('SELECT pg_backend_pid() AS pid');
      const backend = Number(pid.rows[0]?.pid);
      if (Number.isInteger(backend)) {
        cancel = () => { void pool.query('SELECT pg_cancel_backend($1)', [backend]).catch(() => {}); };
        signal.addEventListener('abort', cancel, { once: true });
      }
    }
    return await client.query(sql, params);
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : '';
    if (signal?.aborted || code === '57014') canceled();
    throw error;
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    client.release();
  }
}

async function mysqlQuery(connection: Extract<OpenConnection, { engine: 'mysql' }>, sql: string, params: unknown[], catalog?: string, signal?: AbortSignal): Promise<[RowDataPacket[] | ResultSetHeader, unknown]> {
  const client = await connection.pool.getConnection();
  let cancel: (() => void) | undefined;
  try {
    if (signal?.aborted) canceled();
    if (catalog) await client.query(`USE ${quoteIdent(catalog, 'mysql')}`);
    const threadId = client.threadId;
    if (signal && Number.isInteger(threadId)) {
      cancel = () => { void connection.pool.query(`KILL QUERY ${threadId}`).catch(() => {}); };
      signal.addEventListener('abort', cancel, { once: true });
    }
    return await client.query(sql, params);
  } catch (error) {
    if (signal?.aborted) canceled();
    throw error;
  } finally {
    if (cancel) signal?.removeEventListener('abort', cancel);
    client.release();
  }
}
