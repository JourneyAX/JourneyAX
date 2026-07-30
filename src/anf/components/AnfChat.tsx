'use client';

import { useEffect, useRef, useState } from 'react';
import { useAnf } from '../AnfContext';
import { runStylist } from '../stylist';

const SUGGESTIONS = [
  'Style me for a night out',
  'I need everyday basics',
  'Layer me up for the cold',
];

export default function AnfChat() {
  const { state, dispatch } = useAnf();
  const [prompt, setPrompt] = useState('');
  const endRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [state.messages, state.isThinking]);

  const send = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed || state.isThinking) return;

    dispatch({ type: 'ADD_MESSAGE', role: 'user', text: trimmed });
    dispatch({ type: 'SET_THINKING', thinking: true });
    setPrompt('');

    window.setTimeout(() => {
      const s = stateRef.current;
      const result = runStylist(trimmed, {
        phase: s.phase,
        hasBag: s.bag.length > 0,
        hasRecs: s.recommended.length > 0,
      });

      if (result.reset) {
        dispatch({ type: 'RESET' });
        dispatch({ type: 'SET_THINKING', thinking: false });
        return;
      }

      dispatch({ type: 'ADD_MESSAGE', role: 'ai', text: result.reply });
      if (result.quiz) dispatch({ type: 'SET_QUIZ', questions: result.quiz });
      if (result.phase) dispatch({ type: 'SET_PHASE', phase: result.phase });
      dispatch({ type: 'SET_THINKING', thinking: false });
    }, 650);
  };

  const onSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    send(prompt);
  };

  return (
    <div className="anf-chat">
      <header className="anf-chat__header">
        <div className="anf-wordmark">Abercrombie &amp; Fitch</div>
        <div className="anf-chat__sub">
          <span className="anf-dot" /> AI Personal Stylist
        </div>
      </header>

      <div className="anf-messages">
        {state.messages.map((m) => (
          <div key={m.id} className={`anf-msg anf-msg--${m.role}`}>
            {m.role === 'ai' && <div className="anf-msg__who">STYLIST</div>}
            {m.role === 'note' && m.head && (
              <div className="anf-msg__head">{m.head}</div>
            )}
            <div className="anf-msg__body">{m.text}</div>
          </div>
        ))}
        {state.isThinking && (
          <div className="anf-thinking">
            <span /> <span /> <span />
          </div>
        )}
        <div ref={endRef} />
      </div>

      <div className="anf-input-area">
        {state.phase === 'intro' && (
          <div className="anf-suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s} className="anf-suggestion" onClick={() => send(s)}>
                <span className="anf-suggestion__arrow">→</span>
                {s}
              </button>
            ))}
          </div>
        )}
        <form className="anf-input-row" onSubmit={onSubmit}>
          <input
            className="anf-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="Tell me what you're shopping for…"
          />
          <button type="submit" className="anf-send" aria-label="Send">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path
                d="M4 12h13M11 5l7 7-7 7"
                stroke="#F6F2EA"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
