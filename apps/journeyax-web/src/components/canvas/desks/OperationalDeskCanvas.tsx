'use client';
import { useEffect, useState } from 'react';
import { useAuth } from '@/context/AuthContext';
import { askInChat } from '@/lib/shell/askInChat';
import { deskUrl, type DeskView, type DeskRecord, type DeskField, type CasePreparation } from './operationalDeskApi';
import DeskBoard from './DeskBoard';
import { reviewDeskWork } from '@/lib/shell/deskReview';

interface PreparedWork extends CasePreparation { sessionId?: string; cards?: Array<{ cardType: string; state: Record<string, unknown> }> }

function fieldAt(value: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  for (const key of path.split('.')) {
    if (!value || typeof value !== 'object' || ['__proto__', 'constructor', 'prototype'].includes(key) || !Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function FieldValue({ value, field, record }: { value: unknown; field: DeskField; record: DeskRecord }) {
  const contract = record.provenance.find(entry => entry.fact === `${record.thing}.${field.field}` && entry.status === 'ok')?.contract;
  if (typeof value === 'number' && Number.isFinite(value) && contract?.unit === 'currency amount' && /^[A-Z]{3}$/.test(contract.currency ?? '')) {
    return <span>{new Intl.NumberFormat(undefined, { style: 'currency', currency: contract.currency, currencyDisplay: 'code' }).format(value)}</span>;
  }
  if (field.format === 'messages' && field.messageFields && Array.isArray(value)) {
    const mapping = field.messageFields;
    return <ol aria-label={field.label} style={{ listStyle: 'none', padding: 0, margin: 0 }}>{value.map((entry, index) => <li key={index} style={{ padding: '12px 0', borderBottom: '1px solid var(--border-color, #e5e7eb)' }}>
      <div className="cv__meta">{[fieldAt(entry, mapping.author), fieldAt(entry, mapping.visibility), fieldAt(entry, mapping.time)].filter(item => typeof item === 'string').join(' · ')}</div>
      <Value value={fieldAt(entry, mapping.body)} />
    </li>)}</ol>;
  }
  if (field.format === 'tags' && Array.isArray(value)) return <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>{value.filter(item => typeof item === 'string').map((item, index) => <span className="cv__meta" key={index} style={{ padding: '3px 8px', border: '1px solid var(--border-color, #e5e7eb)', borderRadius: 12 }}>{String(item)}</span>)}</div>;
  return <Value value={value} />;
}

function Value({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (value === undefined || value === null) return <span className="cv__meta">Not available</span>;
  if (typeof value === 'boolean') return <span>{value ? 'Yes' : 'No'}</span>;
  if (typeof value !== 'object') return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(value)}</span>;
  if (depth > 3) return <span className="cv__meta">Open the source record for further detail.</span>;
  if (Array.isArray(value)) return <ul>{value.map((entry, index) => <li key={index}><Value value={entry} depth={depth + 1} /></li>)}</ul>;
  return <dl>{Object.entries(value).map(([label, entry]) => <div key={label}><dt className="cv__meta">{label}</dt><dd><Value value={entry} depth={depth + 1} /></dd></div>)}</dl>;
}

export default function OperationalDeskCanvas({ deskId, projectId, initialMode = 'list', initialRecordId }: { deskId: string; projectId: string; initialMode?: 'list' | 'board'; initialRecordId?: string }) {
  const { user } = useAuth();
  const [recordId, setRecordId] = useState<string | undefined>(initialRecordId);
  const [revision, setRevision] = useState(0);
  const [mode, setMode] = useState(initialMode);
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = cursors.at(-1);
  const [snapshot, setSnapshot] = useState<{ key: string; view: DeskView }>();
  const [error, setError] = useState('');
  const [work, setWork] = useState<Record<string, PreparedWork>>({});
  const owner = `${projectId}:${user?.email ?? ''}`;
  const key = JSON.stringify([owner, deskId, recordId, cursor]);
  const view = snapshot?.key === key ? snapshot.view : undefined;
  const workKey = (record: DeskRecord) => JSON.stringify([owner, deskId, record.canonicalId, record.values.updated]);
  useEffect(() => { setRecordId(initialRecordId); setCursors([]); setMode(initialMode); }, [owner, deskId, initialMode, initialRecordId]);
  useEffect(() => {
    if (!view?.refreshSeconds) return;
    const interval = setInterval(() => { if (document.visibilityState === 'visible') setRevision(value => value + 1); }, view.refreshSeconds * 1000);
    return () => clearInterval(interval);
  }, [view?.refreshSeconds, owner, deskId, recordId, cursor]);
  useEffect(() => {
    const controller = new AbortController();
    setSnapshot(undefined); setError('');
    if (!user) { setError('Sign in to open this working surface.'); return () => controller.abort(); }
    void fetch(deskUrl(projectId, deskId, recordId, cursor), { credentials: 'same-origin', cache: 'no-store', signal: controller.signal }).then(async response => {
      const body = await response.json();
      if (!response.ok || body?.ok !== true || !Array.isArray(body.records) || !Array.isArray(body.columns)) throw new Error(body?.code === 'not_allowed' ? 'This working surface is not available to your role.' : 'These records could not be read. No results are confirmed.');
      if (!controller.signal.aborted) setSnapshot({ key, view: body });
    }).catch(failure => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [owner, deskId, projectId, recordId, cursor, revision, user, key]);

  // Opening a view only reads the shared prepared work. Intake/research belongs to the server worker.
  const preparedFor = (record: DeskRecord): CasePreparation | undefined => record.prepared?.progress ? record.prepared : work[workKey(record)] ?? record.prepared;

  const discuss = (record: DeskRecord) => { askInChat(record.ask); };
  const review = async (record: DeskRecord) => {
    if (!user?.email) return;
    try {
      const response = await fetch(`/api/desks/${encodeURIComponent(deskId)}/prepare?project=${encodeURIComponent(projectId)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ recordId: record.canonicalId, ...(record.prepared?.workId ? { workId: record.prepared.workId } : {}) }) });
      const prepared = await response.json();
      if (!response.ok || prepared?.ok !== true || !prepared.sessionId || !prepared.summary) throw new Error(response.status === 409 ? 'The case changed or another colleague is reviewing it. Refresh the view.' : 'This prepared case could not be opened.');
      setWork(previous => ({ ...previous, [workKey(record)]: prepared }));
      if (!reviewDeskWork({ projectId, person: user.email, recordId: record.canonicalId, sessionId: prepared.sessionId, summary: prepared.summary, cards: prepared.cards ?? [] })) setError('Wait for the current reply to finish, then open the review again.');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'The case could not be opened.'); }
  };
  return <div className="cv"><div className="cv__body">
    <div className="cv__order-head"><div><h2 className="cv__h">{view?.desk.title || 'Working surface'}</h2>{view?.desk.description && <p className="cv__meta">{view.desk.description}</p>}</div><button type="button" className="cv__link" onClick={() => { setCursors([]); setRevision(value => value + 1); }}>Refresh</button></div>
    {recordId && <button type="button" className="cv__link" onClick={() => { setCursors([]); setRecordId(undefined); }}>Back to records</button>}
    {error ? <p role="alert">{error}</p> : !view ? <p role="status">Reading permitted records…</p> : <>
      {view.sample && <p role="note" className="cv__meta">Demonstration data — this view includes a demo source.</p>}
      {view.status === 'partial' && <p role="status">{view.page?.more ? 'More records are available. Continue to the next page to see them.' : 'Some details could not be loaded. This is not a complete result.'}</p>}
      {!recordId && view.board && <div className="cv__tabs" role="group" aria-label="Working surface view"><button type="button" aria-pressed={mode === 'list'} onClick={() => setMode('list')}>{view.desk.title}</button><button type="button" aria-pressed={mode === 'board'} onClick={() => setMode('board')}>{view.board.title}</button></div>}
      {!recordId && mode === 'board' && view.board ? <DeskBoard view={view} preparations={Object.fromEntries(view.records.map(record => [record.canonicalId, preparedFor(record)?.status ?? 'awaiting_intake']))} onOpen={record => { setCursors([]); setRecordId(record.canonicalId); }} /> : <>
      {!view.records.length && <p className="cv__meta">No matching records were returned.</p>}
      {view.records.map(record => <section className="dash__section" key={`${record.thing}:${record.canonicalId}`}>
        <h3 className="cv__h">{record.canonicalId}</h3>
        <dl>{view.columns.map(column => <div className="dash__row" key={column.field}><dt className="cv__meta">{column.label}</dt><dd style={{ minWidth: 0 }}><FieldValue value={record.values[column.field]} field={column} record={record} /></dd></div>)}</dl>
        <p className="cv__meta">{[...new Set(record.provenance.map(fact => fact.source?.displayName).filter(Boolean))].join(' · ')}</p>
        {view.preparationAvailable && <div role="status">
          <p className="cv__meta">{preparedFor(record)?.progress ? 'Reviewed — source action outcomes are recorded below.' : preparedFor(record)?.status === 'waiting_for_approval' ? 'Prepared — waiting for human review and approval.' : preparedFor(record)?.status === 'ready' ? 'Investigation prepared for review.' : preparedFor(record)?.status === 'failed' ? 'The background investigation could not finish. No resolution is confirmed.' : preparedFor(record)?.status === 'preparing' ? 'Background agent is researching this request.' : preparedFor(record)?.status === 'not_scheduled' ? 'Outside automatic intake: only newly changed open requests are scheduled.' : view.preparationMode === 'background' ? 'Awaiting background intake. Opening this record does not start research.' : 'Manual investigation is available.'}</p>
          {(preparedFor(record)?.progress?.summary || preparedFor(record)?.summary) && <p style={{ whiteSpace: 'pre-wrap' }}>{preparedFor(record)?.progress?.summary || preparedFor(record)?.summary}</p>}
          {preparedFor(record)?.progress?.actions.map(action => <p className="cv__meta" key={action.confirmationId}>Source action: {action.outcome === 'confirmed' ? 'confirmed by source' : action.outcome === 'declined' ? 'declined by reviewer' : 'failed — no successful change confirmed'}</p>)}
          {(preparedFor(record)?.summary || view.preparationMode !== 'background') && <button type="button" className="cv__btn" onClick={() => { void review(record); }}>{view.preparationMode === 'background' ? 'Review prepared case' : 'Investigate in chat'}</button>}
        </div>}
        <div className="cv__actions">{!recordId && <button type="button" className="cv__btn cv__btn--ghost" onClick={() => { setCursors([]); setRecordId(record.canonicalId); }}>Open record</button>}<button type="button" className="cv__btn" onClick={() => discuss(record)}>Discuss in chat</button></div>
      </section>)}
      </>}
      <div className="cv__actions">{cursors.length > 0 && <button type="button" className="cv__btn cv__btn--ghost" onClick={() => setCursors(value => value.slice(0, -1))}>Previous page</button>}{view.page?.more && view.page.nextCursor && <button type="button" className="cv__btn" onClick={() => setCursors(value => [...value, view.page!.nextCursor!])}>Next page</button>}</div>
    </>}
  </div></div>;
}
