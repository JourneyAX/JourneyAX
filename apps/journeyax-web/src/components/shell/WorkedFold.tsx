'use client';

/**
 * What the agent did for a turn, in plain language.
 *   WorkingLive    while the turn runs: a pulsing dot, the step in progress and the seconds so far; opens to the steps done.
 *   WorkedSummary  after the answer: one quiet line, "Worked for 12 s", that opens to the same steps.
 * The step wording is whatever the caller supplies (ChatPanel's plain-language trace labels).
 */
import { useEffect, useId, useMemo, useState } from 'react';
import { formatSeconds, formatWorkedFor, type WorkedTrace } from '@/lib/shell/worked';
import { CheckIcon, ChevronRightIcon } from './icons';

export function WorkedSummary({ trace }: { trace: WorkedTrace }) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const expandable = trace.steps.length > 0;
  return (
    <div className="ax-worked" data-open={open}>
      {expandable ? (
        <button type="button" className="ax-worked__toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((v) => !v)}>
          <span>{formatWorkedFor(trace.seconds)}</span>
          <ChevronRightIcon size={14} className="ax-worked__chev" />
        </button>
      ) : (
        <span className="ax-worked__toggle ax-worked__toggle--static">{formatWorkedFor(trace.seconds)}</span>
      )}
      {expandable && open && (
        <ol id={listId} className="ax-worked__steps">
          {trace.steps.map((step, i) => (
            <li key={`${i}-${step}`}><CheckIcon size={13} /><span>{step}</span></li>
          ))}
        </ol>
      )}
    </div>
  );
}

interface LiveWorking {
  startedAt: number;
  steps: { title: string; status?: 'done' | 'running' | 'pending' }[];
}

export function WorkingLive({ working }: { working: LiveWorking | null | undefined }) {
  // Which turn the person opened the steps of: a new turn (new start time) starts folded again without any reset logic.
  const [openFor, setOpenFor] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const listId = useId();
  const startedAt = working?.startedAt;

  useEffect(() => {
    if (startedAt === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);
  const open = startedAt !== undefined && openFor === startedAt;

  const steps = useMemo(() => working?.steps ?? [], [working?.steps]);
  const current = useMemo(() => {
    const running = [...steps].reverse().find((s) => s.status === 'running');
    return running?.title || steps[steps.length - 1]?.title || 'Thinking…';
  }, [steps]);
  if (!working) return null;
  const elapsed = Math.max(0, Math.round((now - working.startedAt) / 1000));
  const expandable = steps.length > 0;

  return (
    <div className="ax-worked ax-worked--live" data-open={open}>
      <button
        type="button"
        className="ax-worked__toggle"
        aria-expanded={expandable ? open : undefined}
        aria-controls={expandable ? listId : undefined}
        onClick={() => expandable && setOpenFor(open ? null : startedAt ?? null)}
      >
        <span className="ax-worked__dot" aria-hidden="true" />
        <span className="ax-worked__now">{current}</span>
        <span className="ax-worked__time">{formatSeconds(elapsed)}</span>
        {expandable && <ChevronRightIcon size={14} className="ax-worked__chev" />}
      </button>
      <span className="ax-sr" role="status">{current}</span>
      {expandable && open && (
        <ol id={listId} className="ax-worked__steps">
          {steps.map((step, i) => (
            <li key={`${i}-${step.title}`} data-status={step.status || 'done'}>
              {step.status === 'running' ? <span className="ax-worked__dot ax-worked__dot--small" aria-hidden="true" /> : <CheckIcon size={13} />}
              <span>{step.title}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
