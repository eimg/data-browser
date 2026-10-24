import { useEffect, useState, type FormEvent } from 'react';
import { connect, currentSession, disconnect } from './api';
import { engineLabel, validateConnection, type Engine, type SessionInfo } from './shared/connection';

const defaultPorts: Record<Exclude<Engine, 'sqlite'>, string> = { postgres: '5432', mysql: '3306' };

type ServerDraft = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
  ssl: boolean;
};

const emptyServer: ServerDraft = { host: '', port: defaultPorts.postgres, user: '', password: '', database: '', ssl: false };

export default function App() {
  const [engine, setEngine] = useState<Engine>('postgres');
  const [server, setServer] = useState<ServerDraft>(emptyServer);
  const [sqlitePath, setSqlitePath] = useState('');
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [ready, setReady] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    currentSession()
      .then(found => { if (active) setSession(found); })
      .catch(cause => { if (active) setError(cause instanceof Error ? cause.message : 'Could not check the connection'); })
      .finally(() => { if (active) setReady(true); });
    return () => { active = false; };
  }, []);

  function chooseEngine(next: Engine) {
    setError('');
    setEngine(next);
    if (next === 'sqlite') return;
    setServer(current => current.port === defaultPorts.postgres || current.port === defaultPorts.mysql
      ? { ...current, port: defaultPorts[next] }
      : current);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setPending(true);
    try {
      const input = engine === 'sqlite'
        ? validateConnection({ engine, path: sqlitePath })
        : validateConnection({
          engine,
          host: server.host,
          port: server.port,
          user: server.user,
          password: server.password,
          database: server.database,
          ssl: server.ssl,
        });
      setSession(await connect(input));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect');
    } finally {
      setPending(false);
    }
  }

  async function onDisconnect() {
    setError('');
    setPending(true);
    try {
      await disconnect();
      setSession(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disconnect');
    } finally {
      setPending(false);
    }
  }

  if (!ready) return <main className="shell"><p className="status">Checking for an open connection…</p></main>;
  if (session) return <Connected session={session} pending={pending} error={error} onDisconnect={() => { void onDisconnect(); }} />;

  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Data browser</p>
        <h1>Connect a database</h1>
        <p>Enter the database you want to browse. These details stay in this local server’s memory and are not written to a file.</p>
      </header>
      <form onSubmit={event => { void onSubmit(event); }}>
        <div className="engines" role="radiogroup" aria-label="Database engine">
          {(['postgres', 'mysql', 'sqlite'] as const).map(choice => (
            <button key={choice} type="button" role="radio" aria-checked={engine === choice} className={engine === choice ? 'selected' : ''} onClick={() => chooseEngine(choice)}>
              {engineLabel(choice)}
            </button>
          ))}
        </div>
        {engine === 'sqlite' ? (
          <label>
            Database file
            <input value={sqlitePath} onChange={event => setSqlitePath(event.target.value)} placeholder="/path/to/database.sqlite" autoComplete="off" spellCheck={false} />
          </label>
        ) : (
          <>
            <div className="split">
              <label>
                Host
                <input value={server.host} onChange={event => setServer({ ...server, host: event.target.value })} placeholder="127.0.0.1" autoComplete="off" spellCheck={false} />
              </label>
              <label>
                Port
                <input value={server.port} onChange={event => setServer({ ...server, port: event.target.value })} inputMode="numeric" autoComplete="off" />
              </label>
            </div>
            <label>
              User
              <input value={server.user} onChange={event => setServer({ ...server, user: event.target.value })} autoComplete="username" spellCheck={false} />
            </label>
            <label>
              Password
              <input value={server.password} onChange={event => setServer({ ...server, password: event.target.value })} type="password" autoComplete="current-password" />
            </label>
            <label>
              Database
              <input value={server.database} onChange={event => setServer({ ...server, database: event.target.value })} autoComplete="off" spellCheck={false} />
            </label>
            <label className="check">
              <input type="checkbox" checked={server.ssl} onChange={event => setServer({ ...server, ssl: event.target.checked })} />
              Use SSL
            </label>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={pending}>{pending ? 'Connecting…' : 'Connect'}</button>
      </form>
    </main>
  );
}

function Connected({ session, pending, error, onDisconnect }: { session: SessionInfo; pending: boolean; error: string; onDisconnect: () => void }) {
  const file = session.engine === 'sqlite';
  return (
    <main className="shell">
      <header>
        <p className="eyebrow">Connected</p>
        <h1>{engineLabel(session.engine)}</h1>
        <p>{file ? 'The file is open on this machine.' : 'The server accepted this login.'}</p>
      </header>
      <dl>
        <div>
          <dt>{file ? 'File' : 'Database'}</dt>
          <dd>{session.database}</dd>
        </div>
        <div>
          <dt>Version</dt>
          <dd>{session.version}</dd>
        </div>
      </dl>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="secondary" disabled={pending} onClick={onDisconnect}>{pending ? 'Disconnecting…' : 'Disconnect'}</button>
    </main>
  );
}
