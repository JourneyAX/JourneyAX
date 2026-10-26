'use client';

/**
 * My tickets: the care person's queue, soonest promised time first. Opens in the side panel like the cart and the order do; pressing a
 * ticket opens it in the same panel, and "Take the next one" opens the ticket that is closest to late.
 */
import { useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { CARE_TICKETS, STATUS_WORD, nextCareTicket, slaClock, type CareStatus, type CareTicket } from './careData';

type Filter = 'need' | 'all';

const needsMe = (t: CareTicket) => t.status === 'decide' || t.status === 'lead';
const openTicket = (ticketId: string) => openCanvas({ kind: 'care-ticket', params: { ticketId } });

export function StatusChip({ status }: { status: CareStatus }) {
  const s = STATUS_WORD[status];
  return <span className={`cv__chip cv__chip--${s.tone}`}><span aria-hidden="true">{s.icon}</span> {s.word}</span>;
}

export default function CareQueueCanvas() {
  const [filter, setFilter] = useState<Filter>('need');
  const tickets = [...CARE_TICKETS].sort((a, b) => (needsMe(b) ? 1 : 0) - (needsMe(a) ? 1 : 0) || a.slaMinutes - b.slaMinutes);
  const shown = tickets.filter((t) => filter === 'all' || needsMe(t));
  const need = tickets.filter(needsMe).length;
  const toDecide = tickets.filter((t) => t.status === 'decide').length;
  const forLead = tickets.filter((t) => t.status === 'lead').length;
  const next = nextCareTicket();

  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Customer care</div>
            <div className="cv__order-no">{toDecide} for you to decide</div>
            <div className="cv__meta">{forLead > 0 ? `${forLead} waiting for the team lead · ` : ''}Aroha Ngata · CSR-1041</div>
          </div>
          <button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'care-board' })}>Care board</button>
        </div>

        <div className="cv__tabs" role="group" aria-label="Show">
          <button type="button" aria-pressed={filter === 'need'} onClick={() => setFilter('need')}>Needs attention ({need})</button>
          <button type="button" aria-pressed={filter === 'all'} onClick={() => setFilter('all')}>All ({tickets.length})</button>
        </div>

        <ul className="cv__tickets">
          {shown.map((t) => {
            const clock = slaClock(t.slaMinutes);
            const done = t.status === 'done';
            return (
              <li key={t.id}>
                <button type="button" className={`cv__ticket${done ? ' cv__ticket--done' : ''}`} onClick={() => openTicket(t.id)}>
                  <span className="cv__ticket-top">
                    <StatusChip status={t.status} />
                    <span className="cv__ticket-subject">{t.subject}</span>
                    {!done && <span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span>}
                  </span>
                  <span className="cv__meta">#{t.ref} · {t.customer.name} · {t.topic.value} · {t.channel}</span>
                  <span className="cv__ticket-ai"><span className="cv__ai">AI</span> {t.summary}</span>
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
