import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react';
import { useState } from 'react';
import type { Column } from './types';

export type IndexDefinition = { name: string; unique: boolean; columns: string[] };
export function indexableColumns(columns: Column[], sqlite: boolean) {
  return columns.filter(c => !c.binary && !c.generated && (sqlite || !/^(.*text|json)\b/i.test(c.type)));
}
export function suggestedIndexName(table: string, columns: string[], unique: boolean) {
  return `${unique ? 'uq' : 'idx'}_${table}_${columns.join('_')}`.replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 64);
}

export default function IndexFields({ value, table, columns, onChange }: {
  value: IndexDefinition; table: string; columns: Column[]; onChange: (value: IndexDefinition) => void;
}) {
  const [named, setNamed] = useState(false);
  function change(next: IndexDefinition) {
    onChange(named ? next : { ...next, name: suggestedIndexName(table, next.columns, next.unique) });
  }
  function move(index: number, delta: number) {
    const next = [...value.columns];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    change({ ...value, columns: next });
  }
  return <div className="db-index-fields">
    <label>Index name<input required maxLength={64} value={value.name} onChange={e => { setNamed(true); onChange({ ...value, name: e.target.value }); }} /></label>
    <label className="db-index-unique"><input type="checkbox" checked={value.unique} onChange={e => change({ ...value, unique: e.target.checked })} />Require unique values</label>
    <p className="db-hint">{value.unique ? 'The selected combination of values must be unique. Multiple NULL values are allowed.' : 'An index can speed up queries using these columns.'} Columns are indexed in the order below.</p>
    {value.columns.map((selected, i) => <div key={i} className="db-index-column">
      <label>Index column {i + 1}<select aria-label={`Index column ${i + 1}`} required value={selected} onChange={e => change({ ...value, columns: value.columns.map((c, j) => i === j ? e.target.value : c) })}><option value="" disabled>Choose a column</option>{columns.map(c => <option key={c.name} value={c.name} disabled={value.columns.some((name, j) => j !== i && name === c.name)}>{c.name}</option>)}</select></label>
      <div className="db-actions"><button type="button" className="icon-button" aria-label={`Move index column ${i + 1} up`} disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp size={15} /></button><button type="button" className="icon-button" aria-label={`Move index column ${i + 1} down`} disabled={i === value.columns.length - 1} onClick={() => move(i, 1)}><ArrowDown size={15} /></button><button type="button" className="icon-button" aria-label={`Remove index column ${i + 1}`} disabled={value.columns.length === 1} onClick={() => change({ ...value, columns: value.columns.filter((_, j) => i !== j) })}><X size={15} /></button></div>
    </div>)}
    <button type="button" className="secondary" disabled={value.columns.length >= Math.min(16, columns.length)} onClick={() => change({ ...value, columns: [...value.columns, columns.find(c => !value.columns.includes(c.name))?.name ?? ''] })}><Plus size={14} />Add index column</button>
    <p className="db-hint">Use SQL for expression, prefix, partial and other advanced indexes. Primary keys are managed separately.</p>
  </div>;
}
