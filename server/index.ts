import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { ConnectionError, validateConnection, type Engine } from '../src/shared/connection';
import { beginJob, cancelJob, finishJob } from './jobs';
import { runOperation } from './operations';
import { closeEngine, connectionFor, listConnections, openEngine } from './sessions';

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

function readBody(req: IncomingMessage, limit = 8_192): Promise<unknown> {
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
      if (size > limit) {
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
    if (url.pathname === '/api/session') {
      await handleSession(req, res);
      return;
    }
    if (url.pathname === '/api/data' && req.method === 'POST') {
      const body = await readBody(req, 2 * 1024 * 1024);
      const record = body && typeof body === 'object' ? body as { id?: unknown; request?: unknown } : {};
      const id = typeof record.id === 'string' ? record.id : '';
      const request = record.request && typeof record.request === 'object' ? record.request as Record<string, unknown> : null;
      if (!id || !request) throw new ConnectionError('Database request is incomplete.');
      const engine = request.driver;
      if (engine !== 'postgres' && engine !== 'mysql' && engine !== 'sqlite') throw new ConnectionError('Choose PostgreSQL, MySQL, or SQLite');
      const controller = new AbortController();
      beginJob(id, () => controller.abort());
      try {
        send(res, 200, await runOperation(connectionFor(sessionId(req), engine), request, controller.signal));
      } finally {
        finishJob(id);
      }
      return;
    }
    if (url.pathname === '/api/data/cancel' && req.method === 'POST') {
      const body = await readBody(req);
      const id = body && typeof body === 'object' && 'id' in body && typeof body.id === 'string' ? body.id : '';
      if (id) cancelJob(id);
      send(res, 200, { ok: true });
      return;
    }
    send(res, 404, { error: 'Not found' });
  } catch (error) {
    const status = error instanceof ConnectionError ? error.status : 500;
    const message = error instanceof ConnectionError ? error.message : 'Could not complete that request';
    if (!(error instanceof ConnectionError)) console.error(error instanceof Error ? error.message : 'Request failed');
    if (!res.headersSent) send(res, status, { error: message });
  }
}

async function handleSession(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = sessionId(req);
  if (req.method === 'GET') {
    send(res, 200, { connections: listConnections(id) });
    return;
  }
  if (req.method === 'DELETE') {
    const engine = new URL(req.url ?? '/', `http://${host}`).searchParams.get('engine');
    const selected = engine === 'postgres' || engine === 'mysql' || engine === 'sqlite' ? engine as Engine : undefined;
    if (engine && !selected) throw new ConnectionError('Choose PostgreSQL, MySQL, or SQLite');
    await closeEngine(id, selected);
    send(res, 200, { ok: true }, selected ? {} : { 'set-cookie': clearCookie() });
    return;
  }
  if (req.method === 'POST') {
    const opened = await openEngine(id, validateConnection(await readBody(req)));
    send(res, 201, opened.info, { 'set-cookie': sessionCookie(opened.id) });
    return;
  }
  send(res, 405, { error: 'Method not allowed' }, { allow: 'GET, POST, DELETE' });
}

server.listen(port, host, () => {
  console.log(`API listening on http://${host}:${port}`);
});
