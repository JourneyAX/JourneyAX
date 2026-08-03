'use client';

import { useJourney } from '@/context/JourneyContext';

export default function ClarifyPanel() {
  const { state, dispatch, isDynamicClarifyComplete } = useJourney();
  const { dynamicQuestions, dynamicAnswers } = state;

  // Build a summary of selected answers to show as chips
  const selectedSummary = dynamicQuestions
    .filter(q => dynamicAnswers[q.id])
    .map(q => ({ label: q.title.replace('?', ''), value: dynamicAnswers[q.id] }));

  const handleSubmit = () => {
    // Call the ChatPanel's submit handler via the window bridge
    const fn = (window as any).__handleClarifySubmit;
    if (fn) fn();
  };

  if (dynamicQuestions.length === 0) {
    return (
      <div className="clarify-panel">
        <div className="clarify-panel__eyebrow">Analysing your request</div>
        <h2 className="clarify-panel__heading">Understanding your project</h2>
        <p className="clarify-panel__desc">
          Loading the right questions for your project…
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
              <div className="clarify-question__options">
                {q.options.map(opt => (
                  <button
                    key={opt}
                    className={`clarify-pill ${dynamicAnswers[q.id] === opt ? 'clarify-pill--selected' : ''}`}
                    onClick={() => dispatch({ type: 'SET_DYNAMIC_ANSWER', questionId: q.id, value: opt })}
                  >
                    {opt}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sticky footer button */}
      <div className="clarify-panel__footer">
        <button
          className="clarify-build-btn"
          disabled={!isDynamicClarifyComplete}
          onClick={handleSubmit}
        >
          Submit my answers
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
            <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
