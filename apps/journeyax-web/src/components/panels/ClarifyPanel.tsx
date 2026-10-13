'use client';

import { useEffect, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';

export default function ClarifyPanel() {
  const { state, dispatch, isDynamicClarifyComplete } = useJourney();
  const { dynamicQuestions, dynamicAnswers } = state;
  const [typedAnswers, setTypedAnswers] = useState<Record<string, string>>({});
  const questionSet = dynamicQuestions.map(q => `${q.id}:${q.title}`).join('|');
  useEffect(() => setTypedAnswers({}), [questionSet]);

  // Build a summary of selected answers to show as chips
  const selectedSummary = dynamicQuestions
    .filter(q => dynamicAnswers[q.id])
    .map(q => ({ label: q.title.replace('?', ''), value: dynamicAnswers[q.id] }));

  const handleSubmit = () => {
    const pending = dynamicQuestions.filter(q => q.options.length === 0 && typedAnswers[q.id]?.trim() && !dynamicAnswers[q.id]);
    if (pending.length) {
      for (const question of pending) {
        dispatch({ type: 'SET_DYNAMIC_ANSWER', questionId: question.id, value: typedAnswers[question.id].trim() });
      }
      // ChatPanel submits once the committed answers are complete; reading state
      // synchronously here would send the previous render's answers.
      return;
    }
    // Call the ChatPanel's submit handler via the window bridge
    const fn = (window as any).__handleClarifySubmit;
    if (fn) fn();
  };
  const ready = isDynamicClarifyComplete || dynamicQuestions.every(q => Boolean(dynamicAnswers[q.id] || typedAnswers[q.id]?.trim()));

  if (dynamicQuestions.length === 0) {
    return (
      <div className="clarify-panel">
        <div className="clarify-panel__eyebrow">Analysing your request</div>
        <h2 className="clarify-panel__heading">Understanding your project</h2>
        <p className="clarify-panel__desc">
          The AI is reading your brief and will generate tailored questions for you shortly…
        </p>
        <div className="thinking" style={{ marginTop: 24 }}>
          <span className="thinking__dot" />
          <span className="thinking__dot" />
          <span className="thinking__dot" />
        </div>
      </div>
    );
  }

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">A few questions</div>
          <h2 className="clarify-panel__heading">Help me understand your needs</h2>
          <p className="clarify-panel__desc">
            Select the options that best describe your situation — I&apos;ll use these to find the right products for you.
          </p>

          {/* Selected answers summary */}
          {selectedSummary.length > 0 && (
            <div className="clarify-chips">
              {selectedSummary.map(p => (
                <div key={p.label} className="clarify-chip">
                  <div className="clarify-chip__label">{p.label}</div>
                  <div className="clarify-chip__value">{p.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Dynamic questions from AI */}
          {dynamicQuestions.map(q => (
            <div key={q.id} className="clarify-question">
              <div className="clarify-question__title">{q.title}</div>
              {q.options.length ? (
                <div className="clarify-question__options">
                  {q.options.map(opt => {
                    const value = typeof opt === 'string' ? opt : opt.value;
                    const label = typeof opt === 'string' ? opt : opt.label;
                    return (
                      <button
                        key={value}
                        className={`clarify-pill ${dynamicAnswers[q.id] === value ? 'clarify-pill--selected' : ''}`}
                        onClick={() => dispatch({ type: 'SET_DYNAMIC_ANSWER', questionId: q.id, value })}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <input
                  className="clarify-question__input"
                  type={q.inputType === 'number' ? 'number' : 'text'}
                  value={typedAnswers[q.id] ?? dynamicAnswers[q.id] ?? ''}
                  placeholder={q.placeholder || (q.inputType === 'measurement' ? 'Enter the measurement and unit' : 'Type your answer')}
                  aria-label={q.title}
                  onChange={event => setTypedAnswers(current => ({ ...current, [q.id]: event.target.value }))}
                />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Sticky footer button */}
      <div className="clarify-panel__footer">
        <button
          className="clarify-build-btn"
          disabled={!ready || state.isThinking}
          onClick={handleSubmit}
        >
          {state.isThinking ? (
            <>
              Finding products...
              <span className="thinking__dot" style={{ marginLeft: 8 }} />
            </>
          ) : (
            <>
              Submit my answers
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
                <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </>
          )}
        </button>
      </div>
    </div>
  );
}
