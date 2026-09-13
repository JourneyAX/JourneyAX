'use client';

/**
 * CommandBar — the floating "talk or type to your consultant" bar (docs/
 * v3-card-cms-architecture.md, artboard: PlaceMakers Voice Bar Main.dc.html).
 * Docked above the stage footer in focus mode, never over a card's own CTA.
 * Presentational only: every handler is passed in from ChatPanel, which
 * already owns the composer state (prompt, pendingImage, streaming) for the
 * non-focus 40/60 layout — this bar drives the exact same functions.
 */
import { useRef } from 'react';
import { useSpeechInput } from '@/lib/voice/useSpeechInput';

export interface CommandBarProps {
  value: string;
  onChange: (v: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onAttachClick: () => void;
  placeholder: string;
  primaryAction?: { label: string; onClick: () => void } | null;
  isLoading: boolean;
  onStop: () => void;
  voiceEnabled?: boolean;
}

export default function CommandBar({
  value, onChange, onSubmit, onKeyDown, onAttachClick, placeholder, primaryAction, isLoading, onStop, voiceEnabled = true,
}: CommandBarProps) {
  const baseValueRef = useRef('');
  const { supported, listening, toggle } = useSpeechInput({
    onInterim: (t) => onChange(`${baseValueRef.current}${baseValueRef.current ? ' ' : ''}${t}`),
    onFinal: (t) => {
      const full = `${baseValueRef.current}${baseValueRef.current ? ' ' : ''}${t}`.trim();
      onChange(full);
      baseValueRef.current = '';
    },
  });

  return (
    <form className="command-bar" onSubmit={onSubmit}>
      <button type="button" className="command-bar__icon-btn" aria-label="Attach" onClick={onAttachClick}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
      </button>
      <input
        className="command-bar__input"
        value={value}
        onChange={(e) => { baseValueRef.current = e.target.value; onChange(e.target.value); }}
        onKeyDown={onKeyDown}
        placeholder={listening ? 'Listening…' : placeholder}
      />
      {primaryAction && (
        <button type="button" className="command-bar__chip" onClick={primaryAction.onClick}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {primaryAction.label}
        </button>
      )}
      {voiceEnabled && supported && (
        <button
          type="button"
          className="command-bar__round command-bar__round--mic"
          data-listening={listening}
          aria-label={listening ? 'Stop listening' : 'Speak'}
          title={listening ? 'Stop listening' : 'Speak'}
          onClick={toggle}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none"><rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" strokeWidth="2" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
      )}
      {isLoading ? (
        <button type="button" className="command-bar__round command-bar__round--stop" aria-label="Stop" title="Stop" onClick={onStop}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
      ) : (
        <button type="submit" className="command-bar__round command-bar__round--send" aria-label="Send">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      )}
    </form>
  );
}
