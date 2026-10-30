import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';

/**
 * An error in the player's words with what to do next. When the cause was on the server or the network, a button
 * copies the technical details for whoever is asked for help.
 */
export function ErrorNote({ of, className = '' }: { of: { failure: Error | null } | Error | string | null; className?: string }) {
  const [copied, setCopied] = useState(false);
  const failure = of === null || typeof of === 'string' || of instanceof Error ? of : of.failure;
  if (!failure) return null;
  const message = typeof failure === 'string' ? failure : failure.message;
  const detail = failure instanceof ApiError && (failure.status === 0 || failure.status >= 500) ? failure.detail : undefined;
  return (
    <div className={`error ${className}`} role="alert">
      <span>{message}</span>
      {detail && (
        <button type="button" className="link" onClick={() => {
          void navigator.clipboard?.writeText(`${detail}\n${new Date().toISOString()}\n${navigator.userAgent}`).then(() => setCopied(true));
        }}>{copied ? '已複製' : '複製錯誤詳情'}</button>
      )}
    </div>
  );
}

/**
 * Asks before something that cannot be taken back. The dialog names the thing, starts on Cancel, closes on
 * Escape or a click outside, and hands focus back to the button that opened it.
 */
export function Confirm({ title, body, action, onConfirm, onClose }: {
  title: string; body: ReactNode; action: string; onConfirm: () => void; onClose: () => void;
}) {
  const box = useRef<HTMLDialogElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  // Layout effect: the dialog must close (and focus go home) before React takes it out of the page.
  useLayoutEffect(() => {
    const el = box.current!;
    const opener = document.activeElement as HTMLElement | null;
    if (!el.open) el.showModal();
    cancel.current?.focus();
    return () => { el.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  return (
    <dialog ref={box} className="confirm" aria-labelledby="confirm-title" onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClick={(e) => { if (e.target === box.current) onClose(); }}>
      <div className="confirm-body">
        <h2 id="confirm-title">{title}</h2>
        <p className="muted">{body}</p>
        <div className="row end">
          <button ref={cancel} type="button" onClick={onClose}>取消</button>
          <button type="button" className="destructive" onClick={() => { onConfirm(); onClose(); }}>{action}</button>
        </div>
      </div>
    </dialog>
  );
}

/** A square button that shows its name in a tooltip on hover and on keyboard focus. */
export function IconButton({ label, children, onClick, disabled }: { label: string; children: ReactNode; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="icon" aria-label={label} data-tip={label} onClick={onClick} disabled={disabled}>
      <span aria-hidden>{children}</span>
    </button>
  );
}

/** Grey bars in the shape of what is loading, so the page does not jump when it arrives. */
export function Bars({ lines = 3, className = '' }: { lines?: number; className?: string }) {
  return (
    <div className={`skeleton ${className}`} aria-hidden>
      {Array.from({ length: lines }, (_, i) => <span key={i} style={{ width: `${92 - ((i * 23) % 40)}%` }} />)}
    </div>
  );
}
