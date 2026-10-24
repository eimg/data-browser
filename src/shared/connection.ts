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
    database: text(body.database, 'Database'),
    ssl: body.ssl,
  };
}
