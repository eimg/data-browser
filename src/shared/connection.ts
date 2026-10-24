export const engines = ['postgres', 'mysql', 'sqlite'] as const;
export type Engine = (typeof engines)[number];

type ServerFields = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

export type PostgresConnection = ServerFields & { engine: 'postgres' };
export type MysqlConnection = ServerFields & { engine: 'mysql' };
export type SqliteConnection = {
  engine: 'sqlite';
  path: string;
};

export type ConnectionInput = PostgresConnection | MysqlConnection | SqliteConnection;

export type SessionInfo = {
  engine: Engine;
  database: string;
  version: string;
};

export class ConnectionError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = 'ConnectionError';
    this.status = status;
  }
}

export const connectionLostMessage = 'The connection was lost. You can reconnect.';

export class LostConnection extends Error {
  constructor() {
    super(connectionLostMessage);
    this.name = 'LostConnection';
  }
}

const sqlitePathProblem = /database file was not found|database path must be a file|unable to open database file|SQLITE_CANTOPEN|SQLITE_NOTADB|file is not a database/i;
const apiUnreachable = /failed to fetch|fetch failed|network error|127\.0\.0\.1:3001/i;
const sessionMissing = /Connect to a database first/;
const serverConnectionLost = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EHOSTUNREACH|EPIPE|PROTOCOL_CONNECTION_LOST|Can't connect to (?:MySQL|the )server|connection terminated|connection ended unexpectedly|connection lost|closed the connection|connection (?:is|was|has been) closed|server has gone away|lost connection|terminating connection|admin shutdown|server shutdown|database system is (?:shutting down|starting up)/i;

function errorDetail(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; current != null && depth < 4; depth += 1) {
    if (current instanceof Error) {
      parts.push(current.message);
      current = current.cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(' ');
}

// SQLite file and path problems stay on the path form. Drop SQLite only when
// its session is gone or the local API can no longer be reached.
export function isConnectionLost(error: unknown, engine?: Engine): boolean {
  if (error instanceof LostConnection) return true;
  const message = errorDetail(error);
  if (message === connectionLostMessage) return true;
  if (sqlitePathProblem.test(message)) return false;
  if (sessionMissing.test(message) || apiUnreachable.test(message)) return true;
  if (engine === 'sqlite') return false;
  return serverConnectionLost.test(message);
}

const engineLabels: Record<Engine, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  sqlite: 'SQLite',
};

export function engineLabel(engine: Engine): string {
  return engineLabels[engine];
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new ConnectionError(`${label} is required`);
  return value.trim();
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ConnectionError('Connection details must be an object');
  return input as Record<string, unknown>;
}

export function validateConnection(input: unknown): ConnectionInput {
  const body = record(input);
  const engine = body.engine;
  if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'sqlite') {
    throw new ConnectionError('Choose PostgreSQL, MySQL, or SQLite');
  }
  if (engine === 'sqlite') {
    return { engine, path: text(body.path, 'Database file') };
  }

  const port = typeof body.port === 'number' ? body.port : Number(body.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConnectionError('Port must be a whole number from 1 to 65535');
  if (body.password !== undefined && typeof body.password !== 'string') throw new ConnectionError('Password must be text');
  if (typeof body.ssl !== 'boolean') throw new ConnectionError('SSL must be yes or no');

  return {
    engine,
    host: text(body.host, 'Host'),
    port,
    user: text(body.user, 'User'),
    password: typeof body.password === 'string' ? body.password : '',
    database: optionalDatabase(body.database),
    ssl: body.ssl,
  };
}

function optionalDatabase(value: unknown): string {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string') throw new ConnectionError('Database must be text');
  return value.trim();
}
