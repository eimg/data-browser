import { randomUUID } from 'node:crypto';
import type { ConnectionInput, SessionInfo } from '../src/shared/connection';
import { openConnection, type OpenConnection } from './open';

type Session = OpenConnection & { id: string };

const sessions = new Map<string, Session>();

export async function openSession(input: ConnectionInput): Promise<SessionInfo & { id: string }> {
  const opened = await openConnection(input);
  const id = randomUUID();
  sessions.set(id, { ...opened, id });
  return { id, engine: opened.engine, database: opened.database, version: opened.version };
}

export function readSession(id: string | undefined): SessionInfo | null {
  if (!id) return null;
  const session = sessions.get(id);
  if (!session) return null;
  return { engine: session.engine, database: session.database, version: session.version };
}

export async function closeSession(id: string | undefined): Promise<void> {
  if (!id) return;
  const session = sessions.get(id);
  if (!session) return;
  sessions.delete(id);
  await session.close();
}
