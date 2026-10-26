'use client';

/**
 * The question a person types to try one scenario. It is kept with the persona library (not in the live pack) and changes nothing the
 * assistant does; clearing it goes back to the wording taken from the test set or worked out from the use case.
 */
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CloseIcon } from '@/components/shell/icons';
import { MAX_PROMPT } from '@/lib/customize/personaApi';

export default function ScenarioQuestionDialog({ title, suggested, current, busy, error, onSave, onClose }: {
  title: string;
  /** The wording used when nothing is set (from the test set, or worked out from the use case). */
  suggested: string;
  /** What is set now ('' when nothing is). */
  current: string;
  busy: boolean;
  error: string;
  onSave: (text: string) => void;
  onClose: () => void;
}) {
  const [text, setText] = useState(current || suggested);
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const clean = text.replace(/\s+/g, ' ').trim();
  // Saving the suggested wording as it is means "nothing is set".
  const toSave = clean === suggested.trim() ? '' : clean;
  const dirty = toSave !== current;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLElement>('textarea')?.focus();
    return () => { if (opener && document.contains(opener)) opener.focus(); };
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return; }
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>('button:not([disabled]), textarea:not([disabled])')];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = (event: FormEvent) => { event.preventDefault(); if (dirty && clean.length > 0) onSave(toSave); };

  return (
    <div className="ax-dialog-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ax-dialog" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ax-dialog__head">
          <h2 id={titleId}>Question for “{title}”</h2>
          <button type="button" className="ax-iconbtn" onClick={onClose} aria-label="Close"><CloseIcon size={18} /></button>
        </div>
        <form onSubmit={submit} noValidate style={{ display: 'contents' }}>
          <div className="ax-dialog__body">
            <p className="ax-hint" style={{ margin: 0 }}>This is what a person types to try the scenario. Write it the way a colleague or customer would say it. It does not change what the assistant does.</p>
            <div className="ax-formrow">
              <label htmlFor={`${titleId}-q`}>The question</label>
              <textarea id={`${titleId}-q`} className="ax-textarea" rows={4} maxLength={MAX_PROMPT} value={text} onChange={(e) => setText(e.target.value)} aria-invalid={clean.length === 0} />
              <span className="ax-hint">{clean.length} of {MAX_PROMPT} characters.{current ? ' Saved question: replaces the suggested wording.' : ' Nothing is set yet, so the suggested wording is used.'}</span>
            </div>
            {current && <button type="button" className="ax-linkbtn" style={{ alignSelf: 'flex-start' }} onClick={() => setText(suggested)}>Use the suggested wording again</button>}
            {error && <p className="ax-error" role="alert">{error}</p>}
          </div>
          <div className="ax-dialog__foot">
            <button type="button" className="ax-btn ax-btn--quiet" onClick={onClose}>Cancel</button>
            <button type="submit" className="ax-btn ax-btn--primary" disabled={busy || !dirty || clean.length === 0}>{busy ? 'Saving…' : toSave === '' && current ? 'Go back to the suggested wording' : 'Save question'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
