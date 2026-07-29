'use client';

const steps = [
  { label: 'Matching the range to your answers', delay: '0s' },
  { label: 'Checking compatibility', delay: '0.5s' },
  { label: 'Pulling live pricing', delay: '1s' },
  { label: 'Confirming stock', delay: '1.5s' },
];

export default function ValidatingPanel() {
  return (
    <div className="validating-panel">
      <div className="validating-spinner" />
      <div className="validating-steps">
        {steps.map(s => (
          <div
            key={s.label}
            className="validating-step"
            style={{ animationDelay: s.delay }}
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="var(--dark)" />
              <path d="M7 12.5l3 3 7-7" stroke="var(--gold-light)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            {s.label}
          </div>
        ))}
      </div>
    </div>
  );
}
