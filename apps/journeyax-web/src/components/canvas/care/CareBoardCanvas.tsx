'use client';

/**
 * Care board: five numbers a care team watches, small enough to leave open, with the longest waits underneath that open the ticket.
 * Time figures are medians, so one slow ticket does not hide the rest.
 */
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { CARE_BOARD, CARE_TICKETS, slaClock } from './careData';
import { StatusChip } from './CareQueueCanvas';

export default function CareBoardCanvas() {
  const b = CARE_BOARD;
  const waiting = CARE_TICKETS.filter((t) => t.status === 'decide' || t.status === 'lead').sort((a, c) => a.slaMinutes - c.slaMinutes).slice(0, 3);
  const maxOpen = Math.max(...b.byPerson.map((p) => p.open), 1);
  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Customer care</div>
            <div className="cv__order-no">Care board</div>
            <div className="cv__meta">Today · time figures are medians</div>
          </div>
          <button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'care-queue' })}>My tickets</button>
        </div>

        <div className="cv__nums">
          <div className="cv__num"><div className="cv__meta">Open now</div><div className="cv__big">{b.open}</div><div className="cv__meta">{b.waitingOnUs} wait on us</div></div>
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

        <h3 className="cv__h">Waiting the longest</h3>
        <ul className="cv__tickets">
          {waiting.map((t) => {
            const clock = slaClock(t.slaMinutes);
            return (
              <li key={t.id}>
                <button type="button" className="cv__ticket" onClick={() => openCanvas({ kind: 'care-ticket', params: { ticketId: t.id } })}>
                  <span className="cv__ticket-top"><StatusChip status={t.status} /><span className="cv__ticket-subject">{t.subject}</span><span className={`cv__clock cv__clock--${clock.tone}`}><span aria-hidden="true">{clock.icon}</span> {clock.text}</span></span>
                  <span className="cv__meta">#{t.ref} · {t.customer.name}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
