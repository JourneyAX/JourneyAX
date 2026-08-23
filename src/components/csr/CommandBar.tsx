'use client';

import { useState, useRef, useEffect } from 'react';
import { useCsr } from '@/context/CsrContext';

/**
 * One box, any input.
 *
 * The live Design Lookup accepts a reference number and nothing else, which is
 * exactly where a customer who has lost their number ends up on the phone.
 * Here the CSR types whatever they were just told.
 *
 * Enter        → search
 * Ctrl+Enter   → send to assist (roster edits, shorthand)
 */
export default function CommandBar() {
  const { state, dispatch, runCommand } = useCsr();
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // A CSR lives on the keyboard while a call is running.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && document.activeElement !== inputRef.current) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const submit = (assist: boolean) => {
    const v = value.trim();
    if (!v) return;
    if (assist) {
      runCommand(v);
      setValue('');
    } else {
      dispatch({ type: 'SEARCH', query: v });
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      submit(e.ctrlKey || e.metaKey);
    }
    if (e.key === 'Escape') setValue('');
  };

  const lastAgent = [...state.log].reverse().find(l => l.role === 'agent');

  return (
    <div className="csr-cmd">
      <div className="csr-cmd__row">
        <span className="csr-cmd__icon" aria-hidden>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
            <circle cx="11" cy="11" r="7" stroke="currentColor" strokeWidth="2" />
            <path d="M20 20l-4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </span>
        <input
          ref={inputRef}
          className="csr-cmd__input"
          value={value}
          onChange={e => setValue(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="School, dealer, sport, S number, PO, style…  or an edit like “drop 7”"
          aria-label="Search or command"
        />
        {state.isThinking && <span className="csr-cmd__spinner" aria-label="Working" />}
        <kbd className="csr-cmd__kbd">/</kbd>
        <button className="csr-cmd__go" onClick={() => submit(false)}>Search</button>
        <button className="csr-cmd__assist" onClick={() => submit(true)} title="Ctrl+Enter">
          Assist
        </button>
      </div>

      {lastAgent && (
        <div className="csr-cmd__reply">
          <span className="csr-cmd__reply-dot" />
          {lastAgent.text}
        </div>
      )}
    </div>
  );
}
