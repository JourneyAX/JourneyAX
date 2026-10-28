'use client';

/**
 * One ticket, with the AI's work-up: what the customer wrote, what was found (each fact with its source), the order, the recommendation, a
 * draft reply the person can edit, and the list of changes that happen when they approve. Nothing is sent or changed until a named care
 * person presses Approve; what they approve is exactly the draft and the steps on the screen at that moment.
 *
 * A ticket that is still being worked on shows what the AI has finished so far, section by section, with a line saying what it is doing
 * now; the sections fill in as the ticket moves on (the store feeds this canvas, so nothing here asks to be refreshed).
 */
import { useEffect, useRef, useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { slaClock, stageIndex, type CareStage, type CareStep, type CareStepKind, type CareTicket, type DeskKind } from './careData';
import { StatusChip } from './CareQueueCanvas';
import { FIXTURES, decide } from './careApi';
import { dayLabel, deskWords, formatMoney } from './deskWords';
import { applyCareEvent, useCareActor, useCareSync, useCareTicket } from './careStore';

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
const reached = (t: CareTicket, stage: CareStage) => stageIndex(t.stage) >= stageIndex(stage);
const clockNow = () => new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

function Chip({ tone, icon, children }: { tone: string; icon?: string; children: React.ReactNode }) {
  return <span className={`cv__chip cv__chip--${tone}`}>{icon && <span aria-hidden="true">{icon} </span>}{children}</span>;
}

/** A section the AI has not finished yet: one line saying what it is doing, so the page never looks empty or stuck. */
function Working({ text }: { text: string }) {
  return <p className="cv__working"><span aria-hidden="true">◐ </span>{text}</p>;
}

export default function CareTicketCanvas({ ticketId, failStep, desk = 'care' }: { ticketId: string; failStep?: string; desk?: DeskKind }) {
  useCareSync(desk);
  const w = deskWords(desk);
  const CARE_STAGES = w.stages;
  const ticket = useCareTicket(ticketId, desk);
  const actor = useCareActor(desk);
  const connected = !FIXTURES;
  const original = ticket?.draft.text ?? '';
  const [draft, setDraft] = useState(original);
  const [touched, setTouched] = useState(false);
  const [editing, setEditing] = useState(false);
  const [localPhase, setPhase] = useState<Phase>('review');
  const [error, setError] = useState('');
  const [states, setStates] = useState<Record<string, StepState>>({});
  const [approvedAt, setApprovedAt] = useState('');
  const [topic, setTopic] = useState(ticket?.topic.value ?? '');
  const [mood, setMood] = useState(ticket?.mood.value ?? '');
  const [correcting, setCorrecting] = useState<'topic' | 'mood' | null>(null);
  // Connected, the care desk says where the changes are (running, failed, done); a preview works it out on this page.
  const serverResults = ticket?.approval?.results ?? [];
  const serverFailed = serverResults.some((r) => !r.ok);
  const serverPhase: Phase | null = connected && ticket ? (ticket.stage === 'done' ? 'done' : ticket.stage === 'running' ? (serverFailed ? 'attention' : 'running') : null) : null;
  const phase: Phase = serverPhase ?? localPhase;
  const failed = useRef<Set<string>>(new Set());
  const timers = useRef<number[]>([]);
  const result = useRef<HTMLDivElement>(null);

  useEffect(() => () => { timers.current.forEach((t) => window.clearTimeout(t)); }, []);
  useEffect(() => {
    setDraft(ticket?.draft.text ?? ''); setTouched(false); setEditing(false); setPhase('review'); setStates({});
    setTopic(ticket?.topic.value ?? ''); setMood(ticket?.mood.value ?? ''); setCorrecting(null); failed.current = new Set();
  }, [ticketId]); // eslint-disable-line react-hooks/exhaustive-deps
  // The AI's draft arrives while the person is watching: show it, unless they have already started editing.
  useEffect(() => { if (!touched) setDraft(original); }, [original, touched]);
  // When the changes finish, or one fails, bring the result into view: it is what the person is waiting for.
  useEffect(() => {
    if (phase === 'done' || phase === 'attention' || phase === 'rejected' || phase === 'sent') result.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [phase]);

  if (!ticket) return <div className="cv"><div className="cv__body"><p className="cv__empty-title">We could not find that {w.one}</p><button type="button" className="cv__link" onClick={() => openCanvas({ kind: w.kinds.queue })}>Back to {w.queueTitle.toLowerCase()}</button></div></div>;

  const t: CareTicket = ticket;
  const quoteCurrency = t.quote?.currency;
  const clock = slaClock(t.slaMinutes);
  const isDone = t.stage === 'done';
  const readIt = reached(t, 'read');
  const researched = reached(t, 'researched');
  const drafted = reached(t, 'drafted');
  const canDecide = reached(t, 'waiting') && !isDone && t.stage !== 'running';
  const stateOf = (s: CareStep): StepState => {
    if (states[s.id] === 'removed' && phase === 'review') return 'removed';
    if (connected && t.approval) {
      const r = serverResults.find((x) => x.stepId === s.id);
      if (r) return r.ok ? 'done' : 'failed';
      const firstOpen = t.steps.find((x) => !serverResults.some((y) => y.stepId === x.id));
      if (t.stage === 'running' && !serverFailed && firstOpen?.id === s.id) return 'running';
      return t.stage === 'done' ? 'done' : 'proposed';
    }
    return states[s.id] ?? 'proposed';
  };
  const live = t.steps.filter((s) => stateOf(s) !== 'removed');
  const edited = draft !== original;
  const locked = phase !== 'review';
  const me = actor ?? { name: t.assignee.name, id: t.assignee.id, isLead: false };
  const leadOnly = t.needsLead && !actor?.isLead;
  const mayDecide = !connected || !actor || actor.isLead || (!t.needsLead && t.assignee.id === actor.id);
  const nextStage = CARE_STAGES.find((s) => stageIndex(s.id) === stageIndex(t.stage) + 1);

  /** Tells the rest of the portal (the list, the board) where this ticket now is. */
  const moveTo = (stage: CareStage, status: CareTicket['status'], note: string) => {
    applyCareEvent({ type: 'ticket', ticket: { ...t, stage, status, timeline: [...t.timeline, { stage, at: clockNow(), note }] } });
  };

  /** Runs the approved steps one after another, each showing its own result. A failed step stops the run and offers a retry. */
  function run(ids: string[], from: number) {
    let i = from;
    const next = () => {
      if (i >= ids.length) { setPhase('done'); moveTo('done', 'done', `Approved by ${t.assignee.name}. All changes made.`); return; }
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
  const approve = async () => {
    setError('');
    if (connected) {
      setEditing(false); setPhase('running');
      const removed = t.steps.filter((s) => states[s.id] === 'removed').map((s) => s.id);
      const answer = await decide(t.id, 'approve', { draft, removedSteps: removed, topic, mood }, desk);
      if (!answer.ok) { setPhase('review'); setError(answer.error); return; }
      applyCareEvent({ type: 'ticket', ticket: answer.ticket });
      return;
    }
    setEditing(false); setApprovedAt(new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }));
    setPhase('running'); moveTo('running', 'waiting', `Approved by ${t.assignee.name}. Making the changes.`); run(live.map((s) => s.id), 0);
  };
  const retry = async () => {
    setError('');
    if (connected) {
      const answer = await decide(t.id, 'retry', {}, desk);
      if (!answer.ok) { setError(answer.error); return; }
      applyCareEvent({ type: 'ticket', ticket: answer.ticket });
      return;
    }
    const ids = live.map((s) => s.id);
    const first = ids.findIndex((id) => states[id] !== 'done');
    setPhase('running'); run(ids, Math.max(first, 0));
  };
  const reject = async () => {
    setError('');
    if (connected) {
      const answer = await decide(t.id, 'reject', {}, desk);
      if (!answer.ok) { setError(answer.error); return; }
      applyCareEvent({ type: 'ticket', ticket: answer.ticket });
    }
    setPhase('rejected');
  };
  const toLead = async () => {
    setError('');
    if (connected) {
      const answer = await decide(t.id, 'to-lead', {}, desk);
      if (!answer.ok) { setError(answer.error); return; }
      applyCareEvent({ type: 'ticket', ticket: answer.ticket });
    }
    setPhase('sent');
  };
  const remove = (id: string) => setStates((s) => ({ ...s, [id]: 'removed' }));
  const restore = (id: string) => setStates((s) => ({ ...s, [id]: 'proposed' }));
  const first = t.customer.name.split(',')[0];

  return (
    <div className="cv">
      <div className="cv__body">
        <button type="button" className="cv__link cv__back" onClick={() => openCanvas({ kind: w.kinds.queue })}>← {w.queueTitle}</button>

        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">{w.one[0].toUpperCase() + w.one.slice(1)}</div>
            <div className="cv__order-no">{w.refPrefix}{t.ref}</div>
            <div className="cv__name">{t.subject}</div>
            <div className="cv__meta">{[t.customer.name, t.customer.account, t.customer.since ? `since ${t.customer.since}` : '', t.customer.earlier].filter(Boolean).join(' · ')}</div>
            <div className="cv__meta">{t.channel} · assigned to {t.assignee.name} ({t.assignee.id})</div>
          </div>
          <div className="cv__head-right">
            <StatusChip status={phase === 'done' ? 'done' : t.status} />
            {t.status !== 'ai' && !isDone && phase !== 'done' && <span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span>}
          </div>
        </div>

        <ol className="cv__track" aria-label={`Where this ${w.one} is`} aria-live="polite">
          {CARE_STAGES.map((s) => {
            const idx = stageIndex(s.id); const at = stageIndex(t.stage);
            const state = idx < at || (isDone && idx === at) ? 'done' : idx === at ? 'now' : 'next';
            return <li key={s.id} className={`cv__track-${state}`}><span className="cv__track-dot" aria-hidden="true">{state === 'done' ? '✓' : state === 'now' ? '◐' : '○'}</span><span>{s.word}</span></li>;
          })}
        </ol>

        <h3 className="cv__h">{w.wrote}</h3>
        <blockquote className="cv__quote">{t.message}</blockquote>

        {readIt ? (
          <div className="cv__labels">
            <span className="cv__ai">AI</span>
            {(['topic', 'mood'] as const).map((which) => {
              const value = which === 'topic' ? topic : mood;
              const firstPick = which === 'topic' ? t.topic : t.mood;
              const options = which === 'topic' ? w.topics : w.moods;
              const changed = value !== firstPick.value;
              return correcting === which ? (
                <select key={which} className="cv__label cv__label--pick" autoFocus value={value} aria-label={`Correct the ${which}`}
                  onChange={(e) => { (which === 'topic' ? setTopic : setMood)(e.target.value); setCorrecting(null); }} onBlur={() => setCorrecting(null)}>
                  {options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              ) : (
                <button key={which} type="button" className="cv__label" disabled={locked} onClick={() => setCorrecting(which)}
                  aria-label={`${which === 'topic' ? w.topicLabel : w.moodLabel}: ${value}. Press to correct it.`}>
                  {which === 'topic' ? w.topicLabel : w.moodLabel}: {value} · {changed ? 'corrected by you' : firstPick.confidence}
                </button>
              );
            })}
          </div>
        ) : <Working text={w.waitingToRead} />}

        <h3 className="cv__h">How I got here</h3>
        <ol className="cv__timeline">
          {t.timeline.map((e) => (
            <li key={`${e.stage}-${e.at}`}><span className="cv__time">{e.at}</span><span><strong>{CARE_STAGES.find((s) => s.id === e.stage)?.word}.</strong> {e.note}</span></li>
          ))}
          {nextStage && stageIndex(nextStage.id) <= stageIndex('waiting') && <li className="cv__timeline-next"><span className="cv__time">now</span><span><span aria-hidden="true">◐ </span>{nextStage.doing}</span></li>}
        </ol>

        <h3 className="cv__h">What I found</h3>
        {researched ? (
          <>
            <ul className="cv__found">
              {t.found.map((f) => <li key={f.text}><span>{f.text}</span><span className="cv__src">{f.source.system} · {f.source.label}</span></li>)}
            </ul>
            {t.notChecked.map((n) => <p key={n} className="cv__gap"><span aria-hidden="true">! </span>Not checked: {n}</p>)}
          </>
        ) : <Working text={w.researching} />}

        {researched && t.order && (
          <>
            <h3 className="cv__h">Order {t.order.ref}</h3>
            <div className="cv__orderbox">
              <div className="cv__states">
                <span>Order <strong>{t.order.states.order}</strong></span>
                <span>Shipment <strong>{t.order.states.shipment}</strong></span>
                <span>Payment <strong>{t.order.states.payment}</strong></span>
              </div>
              <div className="cv__meta">{desk === 'stock' ? `Needed by ${t.order.promised ?? '–'}` : `Promised ${t.order.promised ?? '–'} · Delivered ${t.order.actual ?? '–'}`}</div>
              {t.order.lines.map((l) => <div key={l.name} className="cv__meta">{l.quantity} × {l.name}</div>)}
              {t.order.notes.map((n) => <div key={n} className="cv__meta">Note: {n}</div>)}
            </div>
          </>
        )}

        {researched && t.stock && (
          <>
            <h3 className="cv__h">Stock across branches</h3>
            <div className="cv__orderbox">
              <div className="cv__meta">{t.stock.product.name} · {t.stock.short.branch} needs {t.stock.short.needed} and has {t.stock.short.onHand}.</div>
              <table className="cv__branches" aria-label="Stock by branch">
                <thead><tr><th scope="col">Branch</th><th scope="col">On hand</th><th scope="col">To spare</th><th scope="col"><span className="cv__sr">Role</span></th></tr></thead>
                <tbody>
                  {t.stock.branches.map((b) => (
                    <tr key={b.name} className={`cv__branch cv__branch--${b.role}`}>
                      <th scope="row">{b.name}</th>
                      <td>{b.onHand}</td>
                      <td>{b.role === 'short' ? '–' : b.spare}</td>
                      <td>{b.role === 'short' ? 'Short' : b.role === 'source' ? `Sends the stock${b.note ? ` · ${b.note}` : ''}` : b.note ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        {researched && t.quote && (
          <>
            <h3 className="cv__h">The quote</h3>
            <div className="cv__orderbox">
              <div className="cv__meta">{t.quote.tier} trade prices · {t.quote.discountPercent}% under retail · delivered from {t.quote.branch}{t.quote.validUntil ? ` · prices and stock hold to ${dayLabel(t.quote.validUntil)}` : ''}</div>
              <table className="cv__branches cv__quote" aria-label="Quote lines">
                <thead><tr><th scope="col">Product</th><th scope="col">Qty</th><th scope="col">Each</th><th scope="col">Line total</th><th scope="col">Stock</th></tr></thead>
                <tbody>
                  {t.quote.lines.map((l) => (
                    <tr key={l.sku}>
                      <th scope="row">{l.name}</th>
                      <td>{l.quantity}</td>
                      <td>{formatMoney(l.unitPrice, quoteCurrency)}</td>
                      <td>{formatMoney(l.lineTotal, quoteCurrency)}</td>
                      <td>{l.stock}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><th scope="row" colSpan={3}>Subtotal before GST</th><td>{formatMoney(t.quote.subtotal, quoteCurrency)}</td><td /></tr>
                  <tr><th scope="row" colSpan={3}>GST 15%</th><td>{formatMoney(t.quote.gst, quoteCurrency)}</td><td /></tr>
                  <tr className="cv__quote-total"><th scope="row" colSpan={3}>Total with GST</th><td>{formatMoney(t.quote.total, quoteCurrency)}</td><td /></tr>
                </tfoot>
              </table>
            </div>
          </>
        )}

        <h3 className="cv__h">What I recommend</h3>
        {drafted ? (
          <>
            <p className="cv__rec">{t.recommendation}</p>
            <p className="cv__meta">Other option: {t.otherOption}</p>
          </>
        ) : <Working text={w.drafting} />}

        {drafted && (
          <>
            <h3 className="cv__h">{w.noteHeading(first.split(' ')[0], t.draft.isReply)}</h3>
            {t.draft.isReply
              ? <p className="cv__public"><span aria-hidden="true">✉ </span>This is emailed to {first} and anyone copied in, when you approve.</p>
              : <p className="cv__internal">{w.noteIsInternal}</p>}
            {editing
              ? <textarea className="cv__draft cv__draft--edit" value={draft} onChange={(e) => { setDraft(e.target.value); setTouched(true); }} aria-label="Reply text" rows={9} />
              : <div className="cv__draft">{draft}</div>}
            <div className="cv__row cv__row--tight">
              {!locked && canDecide && <button type="button" className="cv__link" onClick={() => setEditing((v) => !v)}>{editing ? 'Done editing' : 'Edit'}</button>}
              {!locked && edited && <button type="button" className="cv__link" onClick={() => { setDraft(original); setTouched(false); setEditing(false); }}>Undo to the AI version</button>}
              {edited && <Chip tone="info">Edited by you</Chip>}
            </div>
            {(t.draft.isReply || w.showChecksAlways) && (
              <ul className="cv__checks" aria-label={w.checksLabel}>
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
                      {phase === 'review' && canDecide && st !== 'removed' && <button type="button" className="cv__link" onClick={() => remove(s.id)}>Remove</button>}
                      {phase === 'review' && canDecide && st === 'removed' && <button type="button" className="cv__link" onClick={() => restore(s.id)}>Put back</button>}
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}

        <div ref={result} />
        {phase === 'done' && (
          <div className="cv__notice">
            Done. Approved by {t.approval?.by.name ?? t.assignee.name} ({t.approval?.by.id ?? t.assignee.id}) at {t.approval ? new Date(t.approval.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : approvedAt}. {w.doneNote} {(t.approval?.edited ?? edited) ? 'edited' : w.asWritten}. {t.approval ? serverResults.length : live.length} {(t.approval ? serverResults.length : live.length) === 1 ? 'change' : 'changes'} made. Recorded, with the AI version beside the approved one.
          </div>
        )}
        {phase === 'rejected' && <div className="cv__rejected">Not approved. The {w.one} stays with you, the AI work-up stays on it as a note, and nothing was changed in any system.</div>}
        {phase === 'sent' && <div className="cv__rejected">{w.sentToLead('')}</div>}
      </div>

      <div className="cv__foot">
        {!reached(t, 'waiting') && <div className="cv__meta">The AI is still working on this one. What it has finished is above, and the rest fills in by itself.</div>}
        {phase === 'review' && canDecide && !mayDecide && <p className="cv__meta">This {w.one} is assigned to {t.assignee.name}. Only they, or the team lead, can decide it.</p>}
        {phase === 'review' && canDecide && mayDecide && (leadOnly ? (
          <>
            <p className="cv__alert cv__alert--lead">Only the team lead can approve this one: {w.leadReason}</p>
            <button type="button" className="cv__btn cv__btn--primary" onClick={toLead}>{w.sendToLead('')}</button>
            <button type="button" className="cv__btn cv__btn--ghost" onClick={reject}>I will handle it</button>
          </>
        ) : (
          <>
            <button type="button" className="cv__btn cv__btn--primary" disabled={live.length === 0} onClick={approve}>Approve</button>
            <button type="button" className="cv__btn cv__btn--ghost" onClick={reject}>Reject, I will handle it</button>
            <div className="cv__meta">Approving as {me.name} ({me.id}). Nothing is sent or changed until you approve.</div>
          </>
        ))}
        {error && <p className="cv__alert" role="alert">{error}</p>}
        {phase === 'running' && <div className="cv__meta">Making the approved changes…</div>}
        {phase === 'attention' && (
          <>
            <p className="cv__alert">One change did not go through. The {w.one} stays open and needs you.</p>
            <button type="button" className="cv__btn cv__btn--primary" onClick={retry}>Retry the failed change</button>
          </>
        )}
        {(phase === 'done' || phase === 'rejected' || phase === 'sent' || isDone || !reached(t, 'waiting')) && (
          <button type="button" className="cv__btn cv__btn--ghost" onClick={() => openCanvas({ kind: w.kinds.queue })}>Back to {w.queueTitle.toLowerCase()}</button>
        )}
      </div>
    </div>
  );
}
