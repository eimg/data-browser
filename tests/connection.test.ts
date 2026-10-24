import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionError, isConnectionLost, LostConnection, validateConnection } from '../src/shared/connection';

const server = {
  engine: 'postgres',
  host: ' 127.0.0.1 ',
  port: 5432,
  user: ' app ',
  password: ' secret ',
  database: ' school ',
  ssl: false,
};

test('accepts postgres, mysql, and sqlite connection details', () => {
  assert.deepEqual(validateConnection(server), {
    engine: 'postgres', host: '127.0.0.1', port: 5432, user: 'app', password: ' secret ', database: 'school', ssl: false,
  });
  const mysql = validateConnection({ ...server, engine: 'mysql', port: '3306' });
  assert.equal(mysql.engine === 'mysql' && mysql.port, 3306);
  assert.deepEqual(validateConnection({ engine: 'sqlite', path: ' /tmp/app.sqlite ' }), { engine: 'sqlite', path: '/tmp/app.sqlite' });
});

test('rejects missing credentials and unknown engines', () => {
  assert.throws(() => validateConnection({ engine: 'redis' }), ConnectionError);
  assert.throws(() => validateConnection({ ...server, host: ' ' }), /Host is required/);
  assert.throws(() => validateConnection({ ...server, user: '' }), /User is required/);
  const blank = validateConnection({ ...server, database: '' });
  assert.equal(blank.engine === 'postgres' && blank.database, '');
  const omitted = validateConnection({ ...server, database: undefined });
  assert.equal(omitted.engine === 'postgres' && omitted.database, '');
  assert.throws(() => validateConnection({ ...server, port: 0 }), /Port/);
  assert.throws(() => validateConnection({ ...server, port: 70000 }), /Port/);
  assert.throws(() => validateConnection({ ...server, ssl: 'yes' }), /SSL/);
  assert.throws(() => validateConnection({ engine: 'sqlite', path: '' }), /Database file is required/);
});

test('treats a refused or restarted server as a lost connection', () => {
  assert.equal(isConnectionLost(new Error('connect ECONNREFUSED 127.0.0.1:5432'), 'postgres'), true);
  assert.equal(isConnectionLost(new Error('Connection terminated unexpectedly'), 'mysql'), true);
  assert.equal(isConnectionLost(new Error('The server closed the connection'), 'postgres'), true);
  assert.equal(isConnectionLost(new Error('Connect to a database first.'), 'sqlite'), true);
  assert.equal(isConnectionLost(new Error('fetch failed: network error to 127.0.0.1:3001'), 'sqlite'), true);
  assert.equal(isConnectionLost(new LostConnection(), 'mysql'), true);
  assert.equal(isConnectionLost(new Error('no such column: missing'), 'postgres'), false);
  assert.equal(isConnectionLost(new Error('Database file was not found. Choose an existing SQLite file.'), 'sqlite'), false);
  assert.equal(isConnectionLost(new Error('password authentication failed'), 'postgres'), false);
});

test('allows an empty password and keeps surrounding spaces', () => {
  const connection = validateConnection({ ...server, password: '' });
  assert.equal(connection.engine === 'postgres' && connection.password, '');
});
