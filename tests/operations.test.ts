import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ConnectionError } from '../src/shared/connection';
import { openConnection } from '../server/open';
import { runOperation } from '../server/operations';

const signal = new AbortController().signal;

test('browses and edits a SQLite file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-browser-ops-'));
  const path = join(dir, 'app.sqlite');
  new Database(path).close();
  const connection = await openConnection({ engine: 'sqlite', path });
  try {
    const databases = await runOperation(connection, { op: 'databases', driver: 'sqlite', path }, signal);
    assert.deepEqual(databases.databases, [path]);
    await runOperation(connection, {
      op: 'create_table', driver: 'sqlite', path, database: path, table: 'notes',
      columns: [
        { name: 'id', type: 'INTEGER', length: '255', scale: '2', unsigned: false, nullable: false, primary: true, autoIncrement: true, defaultMode: 'none', defaultValue: '' },
        { name: 'body', type: 'TEXT', length: '255', scale: '2', unsigned: false, nullable: true, primary: false, autoIncrement: false, defaultMode: 'none', defaultValue: '' },
      ],
    }, signal);
    await runOperation(connection, { op: 'insert', driver: 'sqlite', path, database: path, table: 'notes', values: { body: 'hello' } }, signal);
    const page = await runOperation(connection, { op: 'rows', driver: 'sqlite', path, database: path, table: 'notes' }, signal);
    const rows = page.rows as { body: string | null }[];
    assert.equal(rows[0]?.body, 'hello');
    assert.equal(page.total, '1');
    const query = await runOperation(connection, { op: 'query', driver: 'sqlite', path, database: path, sql: 'SELECT body FROM notes;' }, signal);
    const sets = query.sets as { rows: (string | null)[][] }[];
    assert.deepEqual(sets[0]?.rows, [['hello']]);
    const structure = await runOperation(connection, { op: 'structure', driver: 'sqlite', path, database: path, table: 'notes' }, signal);
    assert.deepEqual(structure.key, ['id']);
    const indexes = structure.indexes as { name: string; primary: boolean; removable: boolean; parts: { name: string | null }[] }[];
    assert.equal(indexes[0]?.name, 'rowid');
    assert.equal(indexes[0]?.primary, true);
    assert.equal(indexes[0]?.removable, false);
    assert.deepEqual(indexes[0]?.parts.map(part => part.name), ['id']);
    await assert.rejects(
      () => runOperation(connection, { op: 'query', driver: 'sqlite', path, database: path, sql: 'SELECT missing FROM notes;' }, signal),
      (error: unknown) => error instanceof ConnectionError && /missing/i.test(error.message),
    );
  } finally {
    await connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancels a running SQLite statement and leaves the file usable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-browser-cancel-'));
  const path = join(dir, 'app.sqlite');
  new Database(path).close();
  const connection = await openConnection({ engine: 'sqlite', path });
  const controller = new AbortController();
  const slow = runOperation(connection, {
    op: 'query', driver: 'sqlite', path, database: path,
    sql: 'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 100000000) SELECT sum(x) FROM c;',
  }, controller.signal);
  const timer = setTimeout(() => controller.abort(), 150);
  try {
    await assert.rejects(slow, (error: unknown) => error instanceof ConnectionError && error.message === 'Canceled');
    const query = await runOperation(connection, { op: 'query', driver: 'sqlite', path, database: path, sql: 'SELECT 1 AS ok;' }, signal);
    const sets = query.sets as { rows: (string | null)[][] }[];
    assert.deepEqual(sets[0]?.rows, [['1']]);
  } finally {
    clearTimeout(timer);
    await connection.close();
    await rm(dir, { recursive: true, force: true });
  }
});
