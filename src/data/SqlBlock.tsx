import { useState } from 'react';
import { Check, Copy } from 'lucide-react';

export default function SqlBlock({ title, sql, copyLabel = `Copy ${title.toLowerCase()} SQL` }: {
  title: string; sql: string; copyLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState(false);

  async function copy() {
    setError(false);
    setCopied(false);
    try {
      await navigator.clipboard.writeText(sql);
      setCopied(true);
    } catch { setError(true); }
  }

  return <section className="db-sql-block" aria-label={title}>
    <div className="db-sql-block-heading"><h3>{title}</h3><button type="button" className="secondary" aria-label={copyLabel} onClick={() => void copy()}>{copied ? <Check size={14} /> : <Copy size={14} />}<span role="status">{copied ? 'Copied' : 'Copy'}</span></button></div>
    <pre tabIndex={0}><code>{sql}</code></pre>
    {error && <p role="alert">Could not copy SQL. Select and copy the SQL.</p>}
  </section>;
}
