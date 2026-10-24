import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle as drizzleSqlite, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { drizzle as drizzleMysql, type MySql2Database } from 'drizzle-orm/mysql2';
import { drizzle as drizzlePostgres, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import mysql from 'mysql2/promise';
import { Pool } from 'pg';
import { ConnectionError, type ConnectionInput, type MysqlConnection, type PostgresConnection } from '../src/shared/connection';

const connectTimeoutMs = 8000;

export type OpenConnection =
  | { engine: 'postgres'; database: string; version: string; db: NodePgDatabase; close: () => Promise<void> }
  | { engine: 'mysql'; database: string; version: string; db: MySql2Database; close: () => Promise<void> }
  | { engine: 'sqlite'; database: string; version: string; db: BetterSQLite3Database; close: () => Promise<void> };

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

async function openPostgres(input: PostgresConnection): Promise<OpenConnection> {
  const pool = new Pool({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database,
    ssl: input.ssl ? true : undefined,
    max: 4,
    connectionTimeoutMillis: connectTimeoutMs,
    idleTimeoutMillis: 30_000,
  });
  try {
    const result = await pool.query<{ version: string; database: string }>('select version() as version, current_database() as database');
    const row = result.rows[0];
    if (!row?.version || !row.database) throw new ConnectionError('PostgreSQL did not report a server version');
    return {
      engine: 'postgres',
      database: row.database,
      version: row.version,
      db: drizzlePostgres({ client: pool }),
      close: async () => { await pool.end(); },
    };
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
}

async function openMysql(input: MysqlConnection): Promise<OpenConnection> {
  const pool = mysql.createPool({
    host: input.host,
    port: input.port,
    user: input.user,
    password: input.password,
    database: input.database,
    ssl: input.ssl ? { rejectUnauthorized: true } : undefined,
    connectionLimit: 4,
    connectTimeout: connectTimeoutMs,
    waitForConnections: true,
  });
  try {
    const [rows] = await pool.query<mysql.RowDataPacket[]>('select version() as version, database() as `database`');
    const row = rows[0];
    const version = typeof row?.version === 'string' ? row.version : '';
    const database = typeof row?.database === 'string' ? row.database : '';
    if (!version || !database) throw new ConnectionError('MySQL did not report a server version');
    return {
      engine: 'mysql',
      database,
      version,
      db: drizzleMysql({ client: pool }),
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
    const row = sqlite.prepare('select sqlite_version() as version').get() as { version?: string } | undefined;
    if (!row?.version) throw new ConnectionError('SQLite did not report a version');
    return {
      engine: 'sqlite',
      database: path,
      version: row.version,
      db: drizzleSqlite({ client: sqlite }),
      close: async () => { sqlite.close(); },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
