import { useEffect, useId, useRef, useState } from 'react';
import { Check, Copy, Pencil, X } from 'lucide-react';
import { useModalFocus } from '../modal-focus';
import { CELL_CHUNK, fullCell, largeField, MAX_EDIT_BYTES, type CellChunk, type ReadCell } from './row-values';
import type { Column, LargeFields, Row } from './types';

export default function RowViewer({ table, columns, row, position, largeFields = {}, readCell, onClose, onEdit }: {
  table: string; columns: Column[]; row: Row; position?: number; largeFields?: LargeFields; readCell?: ReadCell; onClose: () => void; onEdit?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const title = useId();
  const context = useId();
  const copying = useRef(0);
  const [copied, setCopied] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string } | null>(null);
  const [full, setFull] = useState<Row>({});
  const [parts, setParts] = useState<Record<string, CellChunk>>({});
  const [loading, setLoading] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => { controller.current?.abort(); }, []);
  async function resolve(column: string, signal: AbortSignal) {
    if (!largeField(largeFields, column) || Object.hasOwn(full, column)) return Object.hasOwn(full, column) ? full[column] : row[column] ?? null;
    if (!readCell) throw new Error('Refresh the row to read this value.');
    const value = await fullCell(readCell, column, signal);
    setFull(previous => {
      const bytes = Object.values(previous).reduce((sum, text) => sum + new TextEncoder().encode(text ?? '').length, 0);
      return { ...(bytes + new TextEncoder().encode(value).length <= MAX_EDIT_BYTES ? previous : {}), [column]: value };
    });
    return value;
  }
  async function perform(action: (signal: AbortSignal) => Promise<void>) {
    if (controller.current) return;
    const task = new AbortController(); controller.current = task; setLoading(true); setFeedback(null);
    try { await action(task.signal); }
    catch (error) { if (!task.signal.aborted) setFeedback({ error: true, text: error instanceof Error ? error.message : String(error) }); }
    finally { if (!task.signal.aborted) { controller.current = null; setLoading(false); } }
  }
  async function part(column: string, offset: number, signal: AbortSignal) {
    if (!readCell) return;
    const value = await readCell(column, offset, signal); signal.throwIfAborted();
    setParts(previous => {
      const bytes = Object.values(previous).reduce((sum, part) => sum + new TextEncoder().encode(part.value ?? '').length, 0);
      return { ...(bytes + new TextEncoder().encode(value.value ?? '').length <= MAX_EDIT_BYTES ? previous : {}), [column]: value };
    });
  }
  async function copyRow(signal: AbortSignal) {
    const values: Row = Object.create(null); let bytes = 0;
    for (const column of columns) {
      const value = await resolve(column.name, signal);
      bytes += new TextEncoder().encode(JSON.stringify(value)).length;
      if (bytes > MAX_EDIT_BYTES) throw new Error('Row JSON exceeds the 16 MiB copy limit. Copy individual fields or read them in parts.');
      values[column.name] = value;
    }
    const text = JSON.stringify(values, null, 2);
    if (new TextEncoder().encode(text).length > MAX_EDIT_BYTES) throw new Error('Row JSON exceeds the 16 MiB copy limit. Copy individual fields or read them in parts.');
    await copy('row', text, 'Row JSON');
  }
  useModalFocus(container, true, onClose);
  useEffect(() => () => { copying.current++; }, []);

  async function copy(key: string, text: string, label: string) {
    const request = ++copying.current;
    try {
      await navigator.clipboard.writeText(text);
      if (request !== copying.current) return;
      setCopied(key); setFeedback({ error: false, text: `${label} copied.` });
    } catch {
      if (request !== copying.current) return;
      setCopied(null); setFeedback({ error: true, text: 'Could not copy. Select the value and copy it manually, or try again.' });
    }
  }

  return <div className="modal-backdrop"><div ref={container} className="modal db-row-viewer" role="dialog" aria-modal="true" aria-labelledby={title} aria-describedby={context}>
    <div className="modal-form">
      <header className="card-title"><h2 id={title}>View row</h2><button className="icon-button" type="button" aria-label="Close row viewer" onClick={onClose}><X size={18} /></button></header>
      <div className="db-row-viewer-context" id={context}><strong>{table}</strong><span>{position ? `Row ${position} · ` : ''}{columns.length} {columns.length === 1 ? 'field' : 'fields'}</span></div>
      <div className="modal-form-body">
        <dl className="db-row-values">{columns.map(column => {
          const shownPart = Object.hasOwn(parts, column.name) ? parts[column.name] : undefined;
          const large = largeField(largeFields, column.name);
          const truncated = large && !Object.hasOwn(full, column.name);
          const value = Object.hasOwn(full, column.name) ? full[column.name] : shownPart ? shownPart.value : row[column.name] ?? null;
          return <div key={column.name}>
            <dt><span className="db-row-value-name">{column.name}</span><span className="db-row-value-type">{column.type}</span>
              {(column.columnKey === 'PRI' || column.generated || column.binary) && <span className="db-row-value-tags">{column.columnKey === 'PRI' && <span>Primary key</span>}{column.generated && <span>Generated</span>}{column.binary && <span>Hex</span>}</span>}
            </dt>
            <dd><div className="db-row-value-content">{truncated && <div className="db-large-controls"><p className="db-hint">{shownPart ? `Characters ${shownPart.offset + 1}–${shownPart.nextOffset} of ${shownPart.total.toLocaleString()}` : `Preview · ${large!.length.toLocaleString()} characters`}</p>{readCell && <><button type="button" className="secondary" disabled={loading} onClick={() => void perform(async signal => { await resolve(column.name, signal); })}>Load full {column.name}</button><button type="button" className="secondary" disabled={loading} onClick={() => void perform(signal => part(column.name, 0, signal))}>Read {column.name} in parts</button>{shownPart && <><button type="button" className="secondary" disabled={loading || shownPart.offset === 0} onClick={() => void perform(signal => part(column.name, Math.max(0, shownPart.offset - CELL_CHUNK), signal))}>Previous part</button><button type="button" className="secondary" disabled={loading || shownPart.complete} onClick={() => void perform(signal => part(column.name, shownPart.nextOffset, signal))}>Next part</button><button type="button" className="secondary" disabled={loading} onClick={() => void copy(`part:${column.name}`, shownPart.value ?? 'NULL', 'Shown part')}>Copy shown part</button></>}</>}</div>}{value === null ? <span className="db-row-missing">NULL</span> : value === '' ? <span className="db-row-missing">empty</span> : <pre className={value.length > 16384 ? 'db-full-large' : undefined} tabIndex={value.length > 16384 ? 0 : undefined}>{value}</pre>}</div>
              <button type="button" className="icon-button" disabled={loading} aria-label={`Copy ${column.name}`} title={value === null ? 'Copy SQL NULL' : value === '' ? 'Copy empty text' : 'Copy value'} onClick={() => void perform(async signal => { await copy(`field:${column.name}`, (await resolve(column.name, signal)) ?? 'NULL', column.name); })}>{copied === `field:${column.name}` ? <Check size={15} /> : <Copy size={15} />}</button>
            </dd>
          </div>;
        })}</dl>
      </div>
      <footer className="modal-form-actions db-row-viewer-footer">
        <div className={`db-row-copy-feedback${feedback?.error ? ' error' : ''}`}>
          <span role="status" aria-live="polite">{loading ? 'Loading value…' : feedback && !feedback.error ? feedback.text : ''}</span>
          <span role="alert">{feedback?.error ? feedback.text : ''}</span>
        </div>
        <div className="db-row-viewer-actions"><button type="button" className="secondary db-row-copy-all" title="Copy all fields as JSON, preserving NULL, empty text and exact values" disabled={loading} onClick={() => void perform(copyRow)}>{copied === 'row' ? <Check size={14} /> : <Copy size={14} />}Copy row JSON</button>
          <button type="button" className="secondary" onClick={onClose}>Close</button>{onEdit && <button type="button" className="primary" disabled={loading} onClick={onEdit}><Pencil size={14} />Edit</button>}
        </div>
      </footer>
    </div>
  </div></div>;
}
