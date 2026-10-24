import type { ConnectionInput, SessionInfo } from './shared/connection';

async function request(path: string, method: string, body?: ConnectionInput): Promise<Response> {
  return fetch(path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function result<T>(response: Response): Promise<T> {
  const payload: unknown = await response.json();
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

export async function currentSession(): Promise<SessionInfo | null> {
  const response = await request('/api/session', 'GET');
  if (response.status === 401) return null;
  return result<SessionInfo>(response);
}

export async function disconnect(): Promise<void> {
  await result(await request('/api/session', 'DELETE'));
}
