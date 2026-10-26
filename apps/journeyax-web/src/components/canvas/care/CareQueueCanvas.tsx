'use client';

/**
 * My tickets: the care person's queue, soonest promised time first. Opens in the side panel like the cart and the order do; pressing a
 * ticket opens it in the same panel, and "Take the next one" opens the ticket that is closest to late. A ticket that has just reached the
 * ticket desk appears at the top at once, marked "AI working", and moves on as the AI finishes each stage.
 */
import { useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { CARE_STAGES, STATUS_WORD, nextCareTicket, slaClock, stageIndex, type CareStatus, type CareTicket } from './careData';
import { useCareTickets } from './careStore';

type Filter = 'need' | 'all';

const needsMe = (t: CareTicket) => t.status === 'decide' || t.status === 'lead';
const openTicket = (ticketId: string) => openCanvas({ kind: 'care-ticket', params: { ticketId } });
const AI_STEPS = stageIndex('waiting') + 1;

export function StatusChip({ status }: { status: CareStatus }) {
  const s = STATUS_WORD[status];
  return <span className={`cv__chip cv__chip--${s.tone}`}><span aria-hidden="true">{s.icon}</span> {s.word}</span>;
}

export default function CareQueueCanvas() {
  const all = useCareTickets();
  const [filter, setFilter] = useState<Filter>('need');
  const working = all.filter((t) => t.status === 'ai');
  const rest = all.filter((t) => t.status !== 'ai').sort((a, b) => (needsMe(b) ? 1 : 0) - (needsMe(a) ? 1 : 0) || a.slaMinutes - b.slaMinutes);
  const shown = rest.filter((t) => filter === 'all' || needsMe(t));
  const need = rest.filter(needsMe).length;
  const toDecide = rest.filter((t) => t.status === 'decide').length;
  const forLead = rest.filter((t) => t.status === 'lead').length;
  const next = nextCareTicket(all);

  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Customer care</div>
            <div className="cv__order-no">{toDecide} for you to decide</div>
            <div className="cv__meta">
              {working.length > 0 ? `${working.length} being worked on by the AI · ` : ''}{forLead > 0 ? `${forLead} waiting for the team lead · ` : ''}Aroha Ngata · CSR-1041
            </div>
          </div>
          <button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'care-board' })}>Care board</button>
        </div>

        <div className="cv__tabs" role="group" aria-label="Show">
          <button type="button" aria-pressed={filter === 'need'} onClick={() => setFilter('need')}>Needs attention ({need})</button>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All ({rest.length + working.length})</button>
        </div>

        <ul className="cv__tickets" aria-live="polite">
          {[...working, ...shown].map((t) => {
            const clock = slaClock(t.slaMinutes);
            const done = t.status === 'done';
            const ai = t.status === 'ai';
            const stage = CARE_STAGES.find((s) => s.id === t.stage);
            return (
              <li key={t.id}>
                <button type="button" className={`cv__ticket${done ? ' cv__ticket--done' : ''}${ai ? ' cv__ticket--ai' : ''}`} onClick={() => openTicket(t.id)}>
                  <span className="cv__ticket-top">
                    <StatusChip status={t.status} />
                    <span className="cv__ticket-subject">{t.subject}</span>
                    {ai && <span className="cv__clock cv__clock--ok">Step {stageIndex(t.stage) + 1} of {AI_STEPS}</span>}
                    {!ai && !done && <span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span>}
                  </span>
                  <span className="cv__meta">#{t.ref} · {t.customer.name} · {t.channel}{ai ? '' : ` · ${t.topic.value}`}</span>
                  <span className="cv__ticket-ai"><span className="cv__ai">AI</span> {ai ? `${stage?.word}. ${stage?.doing}` : t.summary}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
      {next && (
        <div className="cv__foot">
          <button type="button" className="cv__btn cv__btn--primary" onClick={() => openTicket(next.id)}>Take the next one (#{next.ref})</button>
          <div className="cv__meta">Sorted by the promised time, soonest first. Nothing is sent or changed until you approve.</div>
        </div>
      )}
    </div>
  );
}
