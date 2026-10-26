'use client';

/**
 * One ticket, with the AI's work-up: what the customer wrote, what was found (each fact with its source), the order, the recommendation, a
 * draft reply the person can edit, and the list of changes that happen when they approve. Nothing is sent or changed until a named care
 * person presses Approve; what they approve is exactly the draft and the steps on the screen at that moment.
 */
import { useEffect, useRef, useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { CARE_MOODS, CARE_TOPICS, careTicket, slaClock, type CareStep, type CareStepKind, type CareTicket } from './careData';
import { StatusChip } from './CareQueueCanvas';

type Phase = 'review' | 'running' | 'attention' | 'done' | 'rejected' | 'sent';
type StepState = 'proposed' | 'running' | 'done' | 'failed' | 'removed';

const KIND_WORD: Record<CareStepKind, string> = { customer: 'Emails the customer', internal: 'Internal only', record: 'Updates a record', money: 'Moves money' };
const STEP_WORD: Record<StepState, { word: string; icon: string; tone: string }> = {
  proposed: { word: 'Proposed', icon: '○', tone: 'info' },
  running: { word: 'Running', icon: '◐', tone: 'wait' },
  done: { word: 'Done', icon: '✓', tone: 'ok' },
  failed: { word: 'Failed', icon: '▲', tone: 'bad' },
  removed: { word: 'Removed', icon: '–', tone: 'info' },
};
const STEP_MS = 700;

function Chip({ tone, icon, children }: { tone: string; icon?: string; children: React.ReactNode }) {
  return <span className={`cv__chip cv__chip--${tone}`}>{icon && <span aria-hidden="true">{icon} </span>}{children}</span>;
}

export default function CareTicketCanvas({ ticketId, failStep }: { ticketId: string; failStep?: string }) {
  const ticket = careTicket(ticketId);
  const original = ticket?.draft.text ?? '';
  const [draft, setDraft] = useState(original);
  const [editing, setEditing] = useState(false);
  const [phase, setPhase] = useState<Phase>('review');
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [approvedAt, setApprovedAt] = useState('');
  const [topic, setTopic] = useState(ticket?.topic.value ?? '');
  const [mood, setMood] = useState(ticket?.mood.value ?? '');
  const [correcting, setCorrecting] = useState<'topic' | 'mood' | null>(null);
  const failed = useRef<Set<string>>(new Set());
  const timers = useRef<number[]>([]);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  useEffect(() => {
    setDraft(ticket?.draft.text ?? ''); setEditing(false); setPhase('review'); setStates({});
    setTopic(ticket?.topic.value ?? ''); setMood(ticket?.mood.value ?? ''); setCorrecting(null); failed.current = new Set();
  }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps
  // When the changes finish, or one fails, bring the result into view: it is what the person is waiting for.
  useEffect(() => {
    if (phase === 'done' || phase === 'attention' || phase === 'rejected' || phase === 'sent') result.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [phase]);

  if (!ticket) return <div className="cv"><div className="cv__body"><p className="cv__empty-title">We could not find that ticket</p><button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'care-queue' })}>Back to my tickets</button></div></div>;

  const t: CareTicket = ticket;
  const clock = slaClock(t.slaMinutes);
  const isDone = t.status === 'done';
  const stateOf = (s: CareStep): StepState => states[s.id] ?? 'proposed';
  const live = t.steps.filter((s) => stateOf(s) !== 'removed');
  const edited = draft !== original;
  const locked = phase !== 'review';

  /** Runs the approved steps one after another, each showing its own result. A failed step stops the run and offers a retry. */
  function run(ids: string[], from: number) {
    let i = from;
    const next = () => {
      if (i >= ids.length) { setPhase('done'); return; }
      const id = ids[i];
      setStates((s) => ({ ...s, [id]: 'running' }));
      timers.current.push(window.setTimeout(() => {
        if (failStep === id && !failed.current.has(id)) {
          failed.current.add(id);
          setStates((s) => ({ ...s, [id]: 'failed' }));
          setPhase('attention');
          return;
        }
        setStates((s) => ({ ...s, [id]: 'done' }));
        i += 1; next();
      }, STEP_MS));
    };
    next();
  }
  const approve = () => {
    setEditing(false); setApprovedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    setPhase('running'); run(live.map((s) => s.id), 0);
  };
  const retry = () => {
    const ids = live.map((s) => s.id);
    const first = ids.findIndex((id) => states[id] !== 'done');
    setPhase('running'); run(ids, Math.max(first, 0));
  };
  const remove = (id: string) => setStates((s) => ({ ...s, [id]: 'removed' }));
  const restore = (id: string) => setStates((s) => ({ ...s, [id]: 'proposed' }));

  return (
    <div className="cv">
      <div className="cv__body">
        <button type="button" className="cv__link cv__back" onClick={() => openCanvas({ kind: 'care-queue' })}>← My tickets</button>

        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Ticket</div>
            <div className="cv__order-no">#{t.ref}</div>
            <div className="cv__name">{t.subject}</div>
            <div className="cv__meta">{t.customer.name} · {t.customer.account} · since {t.customer.since} · {t.customer.earlier}</div>
            <div className="cv__meta">{t.channel} · assigned to {t.assignee.name} ({t.assignee.id})</div>
          </div>
          <div className="cv__head-right">
            <StatusChip status={phase === 'done' ? 'done' : t.status} />
            {!isDone && phase !== 'done' && <span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span>}
          </div>
        </div>

        <div className="cv__labels">
          <span className="cv__ai">AI</span>
          {(['topic', 'mood'] as const).map((which) => {
            const value = which === 'topic' ? topic : mood;
            const first = which === 'topic' ? t.topic : t.mood;
            const options = which === 'topic' ? CARE_TOPICS : CARE_MOODS;
            const changed = value !== first.value;
            return correcting === which ? (
              <select key={which} className="cv__label cv__label--pick" autoFocus value={value} aria-label={`Correct the ${which}`}
                onChange={(e) => { (which === 'topic' ? setTopic : setMood)(e.target.value); setCorrecting(null); }} onBlur={() => setCorrecting(null)}>
                {options.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            ) : (
              <button key={which} type="button" className="cv__label" disabled={locked} onClick={() => setCorrecting(which)}
                aria-label={`${which === 'topic' ? 'Topic' : 'Mood'}: ${value}. Press to correct it.`}>
                {which === 'topic' ? 'Topic' : 'Mood'}: {value} · {changed ? 'corrected by you' : first.confidence}
              </button>
            );
          })}
        </div>

        <h3 className="cv__h">What the customer wrote</h3>
        <blockquote className="cv__quote">{t.message}</blockquote>

        <h3 className="cv__h">What I found</h3>
        <ul className="cv__found">
          {t.found.map((f) => (
            <li key={f.text}><span>{f.text}</span><span className="cv__src">{f.source.system} · {f.source.label}</span></li>
          ))}
        </ul>
        {t.notChecked.map((n) => <p key={n} className="cv__gap"><span aria-hidden="true">! </span>Not checked: {n}</p>)}

        {t.order && (
          <>
            <h3 className="cv__h">Order {t.order.ref}</h3>
            <div className="cv__orderbox">
              <div className="cv__states">
                <span>Order <strong>{t.order.states.order}</strong></span>
                <span>Shipment <strong>{t.order.states.shipment}</strong></span>
                <span>Payment <strong>{t.order.states.payment}</strong></span>
              </div>
              <div className="cv__meta">Promised {t.order.promised ?? '–'} · Delivered {t.order.actual ?? '–'}</div>
              {t.order.lines.map((l) => <div key={l.name} className="cv__meta">{l.quantity} × {l.name}</div>)}
              {t.order.notes.map((n) => <div key={n} className="cv__meta">Note: {n}</div>)}
            </div>
          </>
        )}

        <h3 className="cv__h">What I recommend</h3>
        <p className="cv__rec">{t.recommendation}</p>
        <p className="cv__meta">Other option: {t.otherOption}</p>

        <h3 className="cv__h">{t.draft.isReply ? `Reply to ${t.customer.name.split(',')[0].split(' ')[0]}` : 'Call notes'}</h3>
        {t.draft.isReply
          ? <p className="cv__public"><span aria-hidden="true">✉ </span>This is emailed to {t.customer.name.split(',')[0]} and anyone copied in, when you approve.</p>
          : <p className="cv__internal">Internal only. Nothing here goes to the customer.</p>}
        {editing
          ? <textarea className="cv__draft cv__draft--edit" value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Reply text" rows={9} />
          : <div className="cv__draft">{draft}</div>}
        <div className="cv__row cv__row--tight">
          {!locked && <button type="button" className="cv__link" onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit'}</button>}
          {!locked && edited && <button type="button" className="cv__link" onClick={() => { setDraft(original); setEditing(false); }}>Undo to the AI version</button>}
          {edited && <Chip tone="info">Edited by you</Chip>}
        </div>
        {t.draft.isReply && (
          <ul className="cv__checks" aria-label="Checks on this reply">
            {t.replyChecks.map((c) => <li key={c.label} className={c.ok ? 'cv__check--ok' : 'cv__check--look'}><span aria-hidden="true">{c.ok ? '✓' : '!'}</span> {c.label}</li>)}
          </ul>
        )}

        <h3 className="cv__h">When you approve</h3>
        <ul className="cv__steps">
          {t.steps.map((s) => {
            const st = stateOf(s); const w = STEP_WORD[st];
            return (
              <li key={s.id} className={`cv__step${st === 'removed' ? ' cv__step--removed' : ''}`}>
                <div className="cv__step-main">
                  <div className="cv__step-top"><strong>{s.system}</strong><span className="cv__kind">{KIND_WORD[s.kind]}</span></div>
                  <div>{s.what}</div>
                  {s.after && <div className="cv__change">{s.before ? `${s.before} → ` : ''}{s.after}</div>}
                  {st === 'failed' && <div className="cv__fail">{s.system} did not accept this. Nothing else was changed after it. You can retry.</div>}
                </div>
                <div className="cv__step-side">
                  <Chip tone={w.tone} icon={w.icon}>{w.word}</Chip>
                  {phase === 'review' && st !== 'removed' && <button type="button" className="cv__link" onClick={() => remove(s.id)}>Remove</button>}
                  {phase === 'review' && st === 'removed' && <button type="button" className="cv__link" onClick={() => restore(s.id)}>Put back</button>}
                </div>
              </li>
            );
          })}
        </ul>

        <div ref={result} />
        {phase === 'done' && (
          <div className="cv__notice">
            Done. Approved by {t.assignee.name} ({t.assignee.id}) at {approvedAt}. The reply was {edited ? 'edited by you' : 'sent as written'}. {live.length} {live.length === 1 ? 'change' : 'changes'} made. Recorded, with the AI version beside yours.
          </div>
        )}
        {phase === 'rejected' && <div className="cv__rejected">Not approved. The ticket stays with you, the AI work-up stays on it as a note, and nothing was changed in any system.</div>}
        {phase === 'sent' && <div className="cv__rejected">Sent to Hemi Parata (TL-2001). It shows in the team lead's list as Decide. Nothing has gone to the customer.</div>}
      </div>

      <div className="cv__foot">
        {phase === 'review' && !isDone && (t.needsLead ? (
          <>
            <p className="cv__alert cv__alert--lead">Only the team lead can approve this one: it is a complaint, and the AI is not sure.</p>
            <button type="button" className="cv__btn cv__btn--primary" onClick={() => setPhase('sent')}>Send to Hemi Parata (TL-2001)</button>
            <button type="button" className="cv__btn cv__btn--ghost" onClick={() => setPhase('rejected')}>I will handle it</button>
          </>
        ) : (
          <>
            <button type="button" className="cv__btn cv__btn--primary" disabled={live.length === 0} onClick={approve}>Approve</button>
            <button type="button" className="cv__btn cv__btn--ghost" onClick={() => setPhase('rejected')}>Reject, I will handle it</button>
            <div className="cv__meta">Approving as {t.assignee.name} ({t.assignee.id}). Nothing is sent or changed until you approve.</div>
          </>
        ))}
        {phase === 'running' && <div className="cv__meta">Making the approved changes…</div>}
        {phase === 'attention' && (
          <>
            <p className="cv__alert">One change did not go through. The ticket stays open and needs you.</p>
            <button type="button" className="cv__btn cv__btn--primary" onClick={retry}>Retry the failed change</button>
          </>
        )}
        {(phase === 'done' || phase === 'rejected' || phase === 'sent' || isDone) && (
          <button type="button" className="cv__btn cv__btn--ghost" onClick={() => openCanvas({ kind: 'care-queue' })}>Back to my tickets</button>
        )}
      </div>
    </div>
  );
}
