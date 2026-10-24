import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql, type MySql2Database } from 'drizzle-orm/mysql2';
import { drizzle as drizzlePostgres, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import mysql from 'mysql2/promise';
import pg, { Pool } from 'pg';
import { createHash } from 'node:crypto';
import { ConnectionError, type ConnectionInput, type MysqlConnection, type PostgresConnection } from '../src/shared/connection';

for (const oid of [16, 20, 21, 23, 26, 700, 701, 1082, 1083, 1114, 1184, 1186, 1266, 1700]) {
  pg.types.setTypeParser(oid, value => value);
}

const connectTimeoutMs = 8000;

export type OpenConnection =
  | { engine: 'postgres'; database: string; maintenance: string; version: string; db: NodePgDatabase; config: PostgresConnection; pools: Map<string, Pool>; close: () => Promise<void> }
  | { engine: 'mysql'; database: string; version: string; db: MySql2Database; config: MysqlConnection; pool: mysql.Pool; close: () => Promise<void> }
  | { engine: 'sqlite'; database: string; version: string; db: BetterSQLite3Database; sqlite: Database.Database; close: () => Promise<void> };

function driverMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : fallback;
  return message.replace(/\bpassword=[^\s]*/gi, 'password=(hidden)');
}

export async function openConnection(input: ConnectionInput): Promise<OpenConnection> {
  try {
    if (input.engine === 'sqlite') return await openSqlite(input.path);
    if (input.engine === 'postgres') return await openPostgres(input);
    return await openMysql(input);
  } catch (error) {
    if (error instanceof ConnectionError) throw error;
    throw new ConnectionError(driverMessage(error, 'Could not connect'));
  }
}

function postgresPool(input: PostgresConnection, database: string): Pool {
  return new Pool({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database,
    ssl: input.ssl ? true : undefined,
    max: 4,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
}

function pgCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : '';
}

async function openPostgres(input: PostgresConnection): Promise<OpenConnection> {
  const requested = input.database.trim();
  const candidates = (requested ? [requested] : ['postgres', 'template1', input.user]).filter((name, index, all) => name && all.indexOf(name) === index);
  let last: unknown;
  for (const database of candidates) {
    const pool = postgresPool(input, database);
    try {
      const result = await pool.query<{ version: string; database: string }>('select version() as version, current_database() as database');
      const row = result.rows[0];
      if (!row?.version || !row.database) throw new ConnectionError('PostgreSQL did not report a server version');
      const pools = new Map<string, Pool>([[row.database, pool]]);
      return {
        engine: 'postgres',
        database: row.database,
        maintenance: row.database,
        version: row.version,
        db: drizzlePostgres({ client: pool }),
        config: { ...input, database: row.database },
        pools,
        close: async () => { await Promise.all([...pools.values()].map(item => item.end())); },
      };
    } catch (error) {
      await pool.end().catch(() => {});
      last = error;
      if (error instanceof ConnectionError) throw error;
      if (pgCode(error) === '28P01') throw new ConnectionError('PostgreSQL rejected that user or password');
      if (!['3D000', '28000', '42501'].includes(pgCode(error))) break;
    }
  }
  const detail = driverMessage(last, 'Could not connect');
  if (requested) throw new ConnectionError(detail);
  throw new ConnectionError(`PostgreSQL needs a database named postgres or template1 that this user can open, so the database list can load. ${detail}`);
}

export async function usePostgresDatabase(connection: Extract<OpenConnection, { engine: 'postgres' }>, database: string): Promise<void> {
  if (!connection.pools.has(database)) {
    const pool = postgresPool(connection.config, database);
    try {
      await pool.query('select 1');
    } catch (error) {
      await pool.end().catch(() => {});
      throw new ConnectionError(driverMessage(error, 'Could not open that database'));
    }
    connection.pools.set(database, pool);
  }
  connection.database = database;
}

export async function releasePostgresDatabase(connection: Extract<OpenConnection, { engine: 'postgres' }>, database: string): Promise<void> {
  if (database === connection.maintenance) return;
  const pool = connection.pools.get(database);
  if (!pool) return;
  connection.pools.delete(database);
  if (connection.database === database) connection.database = connection.maintenance;
  await pool.end();
}

async function openMysql(input: MysqlConnection): Promise<OpenConnection> {
  const pool = mysql.createPool({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database || undefined,
    ssl: input.ssl ? { rejectUnauthorized: true } : undefined,
    connectionLimit: 4,
    connectTimeout: connectTimeoutMs,
    waitForConnections: true,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    typeCast(field) {
      const kind = field.type ?? '';
      if (kind === 'BIT' || kind.includes('BLOB') || kind === 'GEOMETRY') {
        const buffer = field.buffer();
        return buffer ? `0x${buffer.toString('hex')}` : null;
      }
      return field.string();
    },
  });
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('select version() as version, database() as `database`');
    const row = rows[0];
    const version = typeof row?.version === 'string' ? row.version : '';
    const database = typeof row?.database === 'string' ? row.database : '';
    if (!version) throw new ConnectionError('MySQL did not report a server version');
    return {
      engine: 'mysql',
      database,
      version,
      db: drizzleMysql({ client: pool }),
      config: input,
      pool,
      close: async () => { await pool.end(); },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

async function openSqlite(filePath: string): Promise<OpenConnection> {
  const path = resolve(filePath);
  let info;
  try {
    info = await stat(path);
  } catch {
    throw new ConnectionError('Database file was not found. Choose an existing SQLite file.');
  }
  if (!info.isFile()) throw new ConnectionError('Database path must be a file');

  const sqlite = new Database(path, { fileMustExist: true });
  try {
    sqlite.pragma('foreign_keys = ON');
    sqlite.function('sha256', { deterministic: true }, (value: unknown) => createHash('sha256').update(String(value ?? '')).digest('hex'));
    const row = sqlite.prepare('select sqlite_version() as version').get() as { version?: string } | undefined;
    if (!row?.version) throw new ConnectionError('SQLite did not report a version');
    return {
      engine: 'sqlite',
      database: path,
      version: row.version,
      db: drizzleSqlite({ client: sqlite }),
      sqlite,
      close: async () => { sqlite.close(); },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
