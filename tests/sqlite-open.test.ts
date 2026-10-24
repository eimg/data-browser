import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { openConnection } from '../server/open';

test('opens an existing SQLite file and refuses a missing path', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-browser-'));
  const path = join(dir, 'app.sqlite');
  const created = new Database(path);
  created.close();

  const opened = await openConnection({ engine: 'sqlite', path });
  assert.equal(opened.engine, 'sqlite');
  assert.equal(opened.database, path);
  assert.match(opened.version, /^\d+\.\d+/);
  await opened.close();

  await assert.rejects(() => openConnection({ engine: 'sqlite', path: join(dir, 'missing.sqlite') }), /not found/);
  await rm(dir, { recursive: true, force: true });
});
