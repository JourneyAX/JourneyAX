'use client';

import { useJourney } from '@/context/JourneyContext';

export default function GuidePanel() {
  const { state, dispatch } = useJourney();
  const { guideSteps } = state;

  const handleComplete = () => {
    // Send a message back to the AI indicating the user has completed the steps
    const completedCount = guideSteps.filter(s => s.completed).length;
    
    let messageText = `I've reviewed the guide.`;
    if (completedCount === guideSteps.length) {
      messageText = `I've completed all ${guideSteps.length} steps in the guide! What's next?`;
    } else if (completedCount > 0) {
      messageText = `I've completed ${completedCount} out of ${guideSteps.length} steps. I need some more help.`;
    } else {
      messageText = `I haven't been able to complete any steps yet. I need more help.`;
    }

    const fn = window.__handleUserMessage;
    if (fn) fn(messageText);
  };

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Troubleshooting Guide</div>
          <h2 className="clarify-panel__heading">Step-by-step instructions</h2>
          <p className="clarify-panel__desc">
            Follow these steps to resolve your issue or prepare for installation. Check them off as you complete them.
          </p>

          <div className="guide-steps" style={{ marginTop: '32px', display: 'flex', flexDirection: 'column', gap: '24px' }}>
            {guideSteps.map((step, index) => (
              <div 
                key={step.id} 
                className={`guide-step ${step.completed ? 'guide-step--completed' : ''}`}
                style={{ 
                  display: 'flex', 
                  flexDirection: 'column',
                  gap: '16px', 
                  padding: '24px', 
                  background: 'var(--surface)', 
                  border: '1px solid var(--border)',
                  borderRadius: '12px',
                  boxShadow: '0 4px 12px rgba(0,0,0,0.03)',
                  opacity: step.completed ? 0.6 : 1,
                  transition: 'all 0.2s ease',
                  position: 'relative'
                }}
              >
                <div style={{ display: 'flex', gap: '16px', alignItems: 'flex-start' }}>
                  <div 
                    className="guide-step__checkbox"
                    onClick={() => dispatch({ type: 'TOGGLE_GUIDE_STEP', id: step.id })}
                    style={{
                      width: '28px',
                      height: '28px',
                      borderRadius: '4px',
                      border: '2px solid var(--gold)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      cursor: 'pointer',
                      flexShrink: 0,
                      marginTop: '2px',
                      background: step.completed ? 'var(--gold)' : 'transparent',
                      transition: 'background 0.2s ease'
                    }}
                  >
                    {step.completed && (
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                        <path d="M4 12l5 5L20 6" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    )}
                  </div>
                  <div className="guide-step__content" style={{ flex: 1 }}>
                    <div className="guide-step__title" style={{ fontWeight: 600, fontSize: '18px', marginBottom: '8px', color: 'var(--text)' }}>
                      Step {index + 1}: {step.title}
                    </div>
                    <div className="guide-step__desc" style={{ color: 'var(--text-dim)', fontSize: '15px', lineHeight: 1.6 }}>
                      {step.description}
                    </div>
                  </div>
                </div>

                {/* Interactive Action Bar */}
                <div style={{ display: 'flex', justifyContent: 'flex-end', borderTop: '1px solid var(--border)', paddingTop: '16px', marginTop: '8px' }}>
                  <button 
                    onClick={() => {
                      const fn = window.__handleUserMessage;
                      if (fn) fn(`I need more help with step ${index + 1}: ${step.title}. Can you explain it in more detail?`);
                    }}
                    style={{
                      background: 'transparent',
                      border: '1px solid var(--gold)',
                      color: 'var(--gold)',
                      padding: '8px 16px',
                      borderRadius: '6px',
                      fontSize: '14px',
                      fontWeight: 500,
                      cursor: 'pointer',
                      transition: 'all 0.2s'
                    }}
                    onMouseOver={(e) => {
                      e.currentTarget.style.background = 'var(--gold)';
                      e.currentTarget.style.color = '#fff';
                    }}
                    onMouseOut={(e) => {
                      e.currentTarget.style.background = 'transparent';
                      e.currentTarget.style.color = 'var(--gold)';
                    }}
                  >
                    Ask a question about this step
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Sticky footer button */}
      <div className="clarify-panel__footer">
        <button className="clarify-build-btn" onClick={handleComplete}>
          I&apos;ve tried these steps — what&apos;s next?
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
            <path d="M4 12h13M11 5l7 7-7 7" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>
    </div>
  );
}
