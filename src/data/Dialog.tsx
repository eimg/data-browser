import { useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useModalFocus } from '../modal-focus';

export default function Dialog({ title, busy, onClose, onSubmit, children, submit = 'Save', cancel = 'Cancel', danger = false, valid = true, showSubmit = true, onCancelBusy }: {
  title: string; busy: boolean; onClose: () => void; onSubmit: () => void;
  children: ReactNode; submit?: string; cancel?: string; danger?: boolean; valid?: boolean; showSubmit?: boolean; onCancelBusy?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const label = useId();
  useModalFocus(container, true, onClose, { canClose: !busy });
  return <div className="modal-backdrop"><div ref={container} className="modal db-dialog" role="dialog" aria-modal="true" aria-labelledby={label}>
    <form className="modal-form" onSubmit={event => { event.preventDefault(); if (!busy && valid) onSubmit(); }}>
      <div className="card-title"><h2 id={label}>{title}</h2></div>
      <div className="modal-form-body"><fieldset disabled={busy}>{children}</fieldset></div>
      <div className="db-dialog-actions modal-form-actions"><button type="button" className="secondary" onClick={busy && onCancelBusy ? onCancelBusy : onClose} disabled={busy && !onCancelBusy}><X size={14} />{busy && onCancelBusy ? 'Cancel import' : cancel}</button>{showSubmit && <button type="submit" className={danger ? 'db-danger' : 'primary'} disabled={busy || !valid}>{busy ? 'Working…' : submit}</button>}</div>
    </form>
  </div></div>;
}
