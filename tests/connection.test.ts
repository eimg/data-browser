import assert from 'node:assert/strict';
import test from 'node:test';
import { ConnectionError, validateConnection } from '../src/shared/connection';

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
  assert.throws(() => validateConnection({ ...server, database: '' }), /Database is required/);
  assert.throws(() => validateConnection({ ...server, port: 0 }), /Port/);
  assert.throws(() => validateConnection({ ...server, port: 70000 }), /Port/);
  assert.throws(() => validateConnection({ ...server, ssl: 'yes' }), /SSL/);
  assert.throws(() => validateConnection({ engine: 'sqlite', path: '' }), /Database file is required/);
});

test('allows an empty password and keeps surrounding spaces', () => {
  const connection = validateConnection({ ...server, password: '' });
  assert.equal(connection.engine === 'postgres' && connection.password, '');
});
