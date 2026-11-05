'use client';
import { useState } from 'react';
import type { DeskRecord, DeskView } from './operationalDeskApi';

/** Reuses the care board's presentation. Counts describe returned records, never invented process progress. */
export function deskGroups(view: DeskView) {
  if (!view.board) return [];
  const board = view.board;
  const groups = board.groups.map(group => ({ ...group, records: view.records.filter(record => String(record.values[board.groupBy] ?? '') === group.value) }));
  const known = new Set(board.groups.map(group => group.value));
  const other = view.records.filter(record => !known.has(String(record.values[board.groupBy] ?? '')));
  return [...groups, ...(other.length ? [{ value: '__other_returned__', label: 'Other returned statuses', records: other }] : [])];
}

export default function DeskBoard({ view, onOpen, preparations = {} }: { view: DeskView; onOpen(record: DeskRecord): void; preparations?: Record<string, string> }) {
  const groups = deskGroups(view);
  const [picked, setPicked] = useState<string>();
  const selected = groups.find(group => group.value === picked) || groups.find(group => group.records.length) || groups[0];
  const partial = view.status === 'partial' || view.page?.more;
  const max = Math.max(1, ...groups.map(group => group.records.length));
  if (!view.board || !selected) return null;
  return <section aria-label={view.board.title}>
    <h3 className="cv__h">{view.board.title}</h3>
    {view.preparationAvailable && <div className="cv__nums" aria-label="Investigation progress on this page">{[['awaiting_intake', 'Awaiting intake'], ['preparing', 'AI investigating'], ['waiting_for_approval', 'Waiting for approval'], ['ready', 'Prepared for review'], ['failed', 'Needs attention']].map(([status, label]) => <div className="cv__num" key={status}><div className="cv__meta">{label}</div><div className="cv__big">{Object.values(preparations).filter(value => value === status).length}</div></div>)}</div>}
    <p className="cv__meta">{partial ? 'Counts cover this page only. More records or details may be available.' : 'Counts cover the returned records.'}</p>
    <ol className="cv__stages" aria-label="Records by source status">{groups.map(group => <li key={group.value}>
      <button type="button" className={`cv__stage${selected.value === group.value ? ' cv__stage--on' : ''}`} aria-pressed={selected.value === group.value} onClick={() => setPicked(group.value)}>
        <span className="cv__stage-n" aria-hidden="true">•</span>
        <span className="cv__stage-word">{group.label}</span>
        <span className="cv__stage-bar" aria-hidden="true"><span style={{ width: `${group.records.length / max * 100}%` }} /></span>
        <strong className="cv__stage-count">{group.records.length}{partial ? '+' : ''}</strong>
      </button>
    </li>)}</ol>
    <h3 className="cv__h">{selected.label}</h3>
    {!selected.records.length && <p className="cv__meta">No records with this status on this page.</p>}
    <ul className="cv__tickets">{selected.records.map(record => <li key={`${record.thing}:${record.canonicalId}`}>
      <button type="button" className="cv__ticket" onClick={() => onOpen(record)}>
        <span className="cv__ticket-top"><span className="cv__ticket-subject">{String(record.values[view.board!.titleField] ?? record.canonicalId)}</span></span>
        <span className="cv__meta">{record.canonicalId} · {String(record.values[view.board!.groupBy] ?? 'Not available')}</span>
        {record.prepared?.summary && <span className="cv__ticket-preview">{record.prepared.summary}</span>}
      </button>
    </li>)}</ul>
  </section>;
}
