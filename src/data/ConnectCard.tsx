import { useState, type FormEvent } from 'react';
import { Database } from 'lucide-react';
import { engineLabel, validateConnection, type ConnectionInput, type Engine } from '../shared/connection';

export default function ConnectCard({ engine, pending, onConnect }: {
  engine: Exclude<Engine, 'sqlite'>;
  pending: boolean;
  onConnect: (input: ConnectionInput) => Promise<void>;
}) {
  const [host, setHost] = useState('127.0.0.1');
  const [port, setPort] = useState(engine === 'postgres' ? '5432' : '3306');
  const [user, setUser] = useState('');
  const [password, setPassword] = useState('');
  const [ssl, setSsl] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    try {
      await onConnect(validateConnection({ engine, host, port, user, password, ssl }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not connect');
    }
  }

  return (
    <section className="settings-card db-empty">
      <Database size={28} />
      <h2>Connect {engineLabel(engine)} to browse your data</h2>
      <p>Sign in to the server. Choose the database from the list after connecting. The password stays in this local server’s memory and is not written to a file. Use the SQLite tab for a file.</p>
      <form className="project-form" onSubmit={event => { void submit(event); }}>
        <div className="port-fields">
          <label><span>Host</span><input value={host} onChange={event => setHost(event.target.value)} autoComplete="off" spellCheck={false} required /></label>
          <label><span>Port</span><input value={port} onChange={event => setPort(event.target.value)} inputMode="numeric" required /></label>
          <label><span>User</span><input value={user} onChange={event => setUser(event.target.value)} autoComplete="username" spellCheck={false} required /></label>
        </div>
        <label><span>Password</span><input value={password} onChange={event => setPassword(event.target.value)} type="password" autoComplete="current-password" /></label>
        <label className="project-check"><input type="checkbox" checked={ssl} onChange={event => setSsl(event.target.checked)} /><span>Use SSL</span></label>
        {error && <div className="notice error" role="alert"><span>{error}</span></div>}
        <div className="button-row"><button className="primary" disabled={pending} type="submit">{pending ? 'Connecting…' : `Connect ${engineLabel(engine)}`}</button></div>
      </form>
    </section>
  );
}
