'use client';

/**
 * Care board: how the tickets are moving through the AI's work and the team's (arrived, AI read it, AI researched, draft ready, waiting for
 * approval, changes running, done), then the few numbers a care team watches. Press a stage to see the tickets in it. Time figures are
 * medians, so one slow ticket does not hide the rest.
 */
import { useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { CARE_BOARD, CARE_STAGES, slaClock, stageIndex, type CareStage } from './careData';
import { useCareTickets } from './careStore';
import { StatusChip } from './CareQueueCanvas';

/** What the rest of the team has at each stage, so the board counts the whole team and not only this person. */
const TEAMMATES: Record<CareStage, number> = { arrived: 0, read: 0, researched: 0, drafted: 0, waiting: 3, running: 1, done: 21 };

export default function CareBoardCanvas() {
  const tickets = useCareTickets();
  const b = CARE_BOARD;
  const count = (stage: CareStage) => tickets.filter((t) => t.stage === stage).length + TEAMMATES[stage];
  const firstBusy = CARE_STAGES.find((s) => s.id !== 'done' && tickets.some((t) => t.stage === s.id))?.id ?? 'waiting';
  const [picked, setPicked] = useState<CareStage | null>(null);
  const stage = picked ?? firstBusy;
  const inStage = tickets.filter((t) => t.stage === stage);
  const info = CARE_STAGES.find((s) => s.id === stage);
  const maxCount = Math.max(...CARE_STAGES.map((s) => count(s.id)), 1);
  const open = CARE_STAGES.filter((s) => s.id !== 'done').reduce((sum, s) => sum + count(s.id), 0);
  const maxOpen = Math.max(...b.byPerson.map((p) => p.open), 1);

  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Customer care</div>
            <div className="cv__order-no">Care board</div>
            <div className="cv__meta">Today · whole team · time figures are medians</div>
          </div>
          <button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'care-queue' })}>My tickets</button>
        </div>

        <h3 className="cv__h cv__h--first">How the tickets are moving</h3>
        <ol className="cv__stages" aria-live="polite">
          {CARE_STAGES.map((s, i) => {
            const n = count(s.id);
            const idx = stageIndex(s.id);
            const aiStage = idx >= stageIndex('read') && idx <= stageIndex('drafted');
            return (
              <li key={s.id}>
                <button type="button" className={`cv__stage${stage === s.id ? ' cv__stage--on' : ''}`} aria-pressed={stage === s.id} onClick={() => setPicked(s.id)}>
                  <span className="cv__stage-n" aria-hidden="true">{i + 1}</span>
                  <span className="cv__stage-word">{s.word}{aiStage && <span className="cv__ai">AI</span>}</span>
                  <span className="cv__stage-bar" aria-hidden="true"><span style={{ width: `${(n / maxCount) * 100}%` }} /></span>
                  <strong className="cv__stage-count">{n}</strong>
                </button>
              </li>
            );
          })}
        </ol>
        <p className="cv__meta cv__stage-doing"><strong>{info?.word}:</strong> {info?.doing}</p>
        {inStage.length === 0
          ? <p className="cv__meta">None of your tickets are at this stage{TEAMMATES[stage] ? `. The other ${TEAMMATES[stage]} belong to your teammates.` : '.'}</p>
          : (
            <ul className="cv__tickets">
              {inStage.map((t) => {
                const clock = slaClock(t.slaMinutes);
                return (
                  <li key={t.id}>
                    <button type="button" className="cv__ticket" onClick={() => openCanvas({ kind: 'care-ticket', params: { ticketId: t.id } })}>
                      <span className="cv__ticket-top"><StatusChip status={t.status} /><span className="cv__ticket-subject">{t.subject}</span>{t.status !== 'ai' && t.status !== 'done' && <span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span>}</span>
                      <span className="cv__meta">#{t.ref} · {t.customer.name} · assigned to {t.assignee.name} ({t.assignee.id})</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

        <h3 className="cv__h">Numbers</h3>
        <div className="cv__nums">
          <div className="cv__num"><div className="cv__meta">Open now</div><div className="cv__big">{open}</div><div className="cv__meta">{count('waiting')} wait on a person</div></div>
          <div className="cv__num"><div className="cv__meta">Close to late</div><div className="cv__big">{b.nearBreach}</div><div className="cv__meta">under 15 minutes or late</div></div>
          <div className="cv__num"><div className="cv__meta">First reply</div><div className="cv__big">{b.firstReplyMinutes} min</div><div className="cv__meta">target {b.firstReplyTargetMinutes} min</div></div>
          <div className="cv__num"><div className="cv__meta">Satisfaction, 7 days</div><div className="cv__big">{b.csat.percent}%</div><div className="cv__meta">{b.csat.ratings} ratings</div></div>
        </div>

        <h3 className="cv__h">AI drafts, last 7 days</h3>
        <div className="cv__split" role="img" aria-label={`${b.drafts.asIs} percent sent as written, ${b.drafts.edited} percent edited, ${b.drafts.discarded} percent discarded`}>
          <span style={{ width: `${b.drafts.asIs}%` }} className="cv__split-a" />
          <span style={{ width: `${b.drafts.edited}%` }} className="cv__split-b" />
          <span style={{ width: `${b.drafts.discarded}%` }} className="cv__split-c" />
        </div>
        <div className="cv__legend"><span>Sent as written {b.drafts.asIs}%</span><span>Edited {b.drafts.edited}%</span><span>Discarded {b.drafts.discarded}%</span></div>

        <h3 className="cv__h">Open by person</h3>
        <ul className="cv__people">
          {b.byPerson.map((p) => (
            <li key={p.id}>
              <span>{p.name} <span className="cv__meta">{p.id}</span></span>
              <span className="cv__bar"><span style={{ width: `${(p.open / maxOpen) * 100}%` }} /></span>
              <strong>{p.open}</strong>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
