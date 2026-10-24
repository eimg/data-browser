import { randomUUID } from 'node:crypto';
import type { ConnectionInput, Engine, SessionInfo } from '../src/shared/connection';
import { openConnection, type OpenConnection } from './open';

type Bag = { id: string; connections: Map<Engine, OpenConnection> };

const sessions = new Map<string, Bag>();

function info(connection: OpenConnection): SessionInfo {
  return { engine: connection.engine, database: connection.database, version: connection.version };
}

export async function openEngine(sessionId: string | undefined, input: ConnectionInput): Promise<{ id: string; info: SessionInfo }> {
  let bag = sessionId ? sessions.get(sessionId) : undefined;
  if (!bag) {
    bag = { id: randomUUID(), connections: new Map() };
    sessions.set(bag.id, bag);
  }
  const opened = await openConnection(input);
  const previous = bag.connections.get(opened.engine);
  bag.connections.set(opened.engine, opened);
  if (previous) await previous.close();
  return { id: bag.id, info: info(opened) };
}

export function listConnections(sessionId: string | undefined): SessionInfo[] {
  const bag = sessionId ? sessions.get(sessionId) : undefined;
  if (!bag) return [];
  return [...bag.connections.values()].map(info);
}

export function connectionFor(sessionId: string | undefined, engine: Engine): OpenConnection | null {
  return sessions.get(sessionId ?? '')?.connections.get(engine) ?? null;
}

export async function closeEngine(sessionId: string | undefined, engine?: Engine): Promise<void> {
  const bag = sessionId ? sessions.get(sessionId) : undefined;
  if (!bag) return;
  const targets = engine ? [bag.connections.get(engine)].filter(item => item !== undefined) : [...bag.connections.values()];
  for (const connection of targets) bag.connections.delete(connection.engine);
  await Promise.all(targets.map(connection => connection.close()));
  if (bag.connections.size === 0) sessions.delete(bag.id);
}
