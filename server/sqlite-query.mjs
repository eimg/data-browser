import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';

process.on('message', message => {
  if (!message || typeof message !== 'object' || typeof message.path !== 'string' || typeof message.sql !== 'string') {
    process.exit(1);
  }
  const db = new Database(message.path, { fileMustExist: true });
  const finish = payload => {
    try { db.close(); } catch { /* The statement may already have closed it. */ }
    if (!process.send) process.exit(1);
    process.send(payload, () => process.exit(0));
  };
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.function('sha256', { deterministic: true }, value => createHash('sha256').update(String(value ?? '')).digest('hex'));
    const statement = db.prepare(message.sql);
    const params = Array.isArray(message.params) ? message.params : [];
    if (message.read) finish({ ok: true, rows: statement.all(...params) });
    else finish({ ok: true, changes: statement.run(...params).changes });
  } catch (error) {
    finish({ ok: false, message: error instanceof Error ? error.message : 'SQLite query failed' });
  }
});
