import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ConnectionError, validateConnection } from '../src/shared/connection';
import { closeSession, openSession, readSession } from './sessions';

const host = '127.0.0.1';
const port = 3001;
const cookieName = 'data_browser_session';

function send(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function sessionCookie(id: string): string {
  return `${cookieName}=${id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=43200`;
}

function clearCookie(): string {
  return `${cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function sessionId(req: IncomingMessage): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === cookieName) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let failed = false;
    const fail = (error: ConnectionError) => {
      if (failed) return;
      failed = true;
      reject(error);
    };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 8_192) {
        fail(new ConnectionError('Request is too large', 413));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text) as unknown);
      } catch {
        fail(new ConnectionError('Request body must be JSON'));
      }
    });
    req.on('error', () => fail(new ConnectionError('Could not read the request', 400)));
  });
}

const server = createServer((req, res) => {
  void handle(req, res);
});

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const url = new URL(req.url ?? '/', `http://${host}`);
    if (req.method === 'GET' && url.pathname === '/api/health') {
      send(res, 200, { ok: true });
      return;
    }
    if (url.pathname !== '/api/session') {
      send(res, 404, { error: 'Not found' });
      return;
    }
    if (req.method === 'GET') {
      const session = readSession(sessionId(req));
      if (!session) {
        send(res, 401, { error: 'Not connected' });
        return;
      }
      send(res, 200, session);
      return;
    }
    if (req.method === 'DELETE') {
      await closeSession(sessionId(req));
      send(res, 200, { ok: true }, { 'set-cookie': clearCookie() });
      return;
    }
    if (req.method === 'POST') {
      await closeSession(sessionId(req));
      const session = await openSession(validateConnection(await readBody(req)));
      send(res, 201, { engine: session.engine, database: session.database, version: session.version }, { 'set-cookie': sessionCookie(session.id) });
      return;
    }
    send(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST, DELETE' });
  } catch (error) {
    const status = error instanceof ConnectionError ? error.status : 500;
    const message = error instanceof ConnectionError ? error.message : 'Could not complete that request';
    if (!(error instanceof ConnectionError)) console.error(error instanceof Error ? error.message : 'Request failed');
    if (!res.headersSent) send(res, status, { error: message });
  }
}

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
