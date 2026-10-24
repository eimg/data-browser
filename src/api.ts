import type { ConnectionInput, Engine, SessionInfo } from './shared/connection';

function unreachable(error: unknown): Error {
  const message = error instanceof Error ? error.message : 'fetch failed';
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : '';
  const detail = [message, cause].filter(Boolean).join(': ');
  if (/127\.0\.0\.1:3001/.test(detail)) return new Error(detail);
  return new Error(`${detail} (network error to 127.0.0.1:3001)`);
}

async function request(path: string, method: string, body?: unknown): Promise<Response> {
  try {
    return await fetch(path, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (error) {
    throw unreachable(error);
  }
}

async function result<T>(response: Response): Promise<T> {
  let payload: unknown;
  try {
    payload = JSON.parse(await response.text()) as unknown;
  } catch {
    throw new Error(response.ok ? 'Request failed' : 'fetch failed: network error to 127.0.0.1:3001');
  }
  if (!response.ok) {
    const message = payload && typeof payload === 'object' && 'error' in payload && typeof payload.error === 'string'
      ? payload.error
      : 'Request failed';
    throw new Error(message);
  }
  return payload as T;
}

export function connect(input: ConnectionInput): Promise<SessionInfo> {
  return request('/api/session', 'POST', input).then(response => result<SessionInfo>(response));
}

export async function currentSession(): Promise<SessionInfo[]> {
  const payload = await result<{ connections: SessionInfo[] }>(await request('/api/session', 'GET'));
  return payload.connections;
}

export async function disconnect(engine?: Engine): Promise<void> {
  const path = engine ? `/api/session?engine=${engine}` : '/api/session';
  await result(await request(path, 'DELETE'));
}

export function dataRequest<T>(id: string, requestBody: Record<string, unknown>): Promise<T> {
  return request('/api/data', 'POST', { id, request: requestBody }).then(response => result<T>(response));
}

export async function cancelData(id: string): Promise<void> {
  await result(await request('/api/data/cancel', 'POST', { id }));
}
