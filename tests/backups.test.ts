import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { listBackupFiles, runOperation } from '../server/operations';

const signal = new AbortController().signal;

test('lists backup files and skips folders', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'data-browser-backups-'));
  try {
    await mkdir(join(dir, 'nested'));
    await writeFile(join(dir, 'notes.sql'), 'SELECT 1;');
    await writeFile(join(dir, 'app.sqlite'), 'not a real db');
    await writeFile(join(dir, 'readme.txt'), 'hi');
    const oldest = new Date('2026-01-01T00:00:00Z');
    const older = new Date('2026-03-01T00:00:00Z');
    const newer = new Date('2026-06-01T00:00:00Z');
    await utimes(join(dir, 'readme.txt'), oldest, oldest);
    await utimes(join(dir, 'notes.sql'), older, older);
    await utimes(join(dir, 'app.sqlite'), newer, newer);
    const listed = await listBackupFiles(dir);
    assert.equal(listed.truncated, false);
    assert.deepEqual(listed.files.map(file => [file.name, file.kind]), [
      ['app.sqlite', 'sqlite'],
      ['notes.sql', 'sql'],
      ['readme.txt', 'other'],
    ]);
    assert.equal(listed.files[0]?.path, join(dir, 'app.sqlite'));
    assert.ok((listed.files[1]?.bytes ?? 0) > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lists backups without a database connection', async () => {
  const result = await runOperation(null, { op: 'list_backups' }, signal);
  assert.equal(result.directory, join(homedir(), '.data-browser', 'backups'));
  assert.ok(Array.isArray(result.files));
});
