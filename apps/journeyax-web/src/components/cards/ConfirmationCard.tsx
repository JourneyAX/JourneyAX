'use client';

const labelOf = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').replace(/^./, letter => letter.toUpperCase());

function ReviewValue({ value }: { value: unknown }) {
  if (value === null) return <span>None</span>;
  if (typeof value !== 'object') return <span style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{String(value)}</span>;
  if (Array.isArray(value)) return <ol>{value.map((entry, index) => <li key={index}><ReviewValue value={entry} /></li>)}</ol>;
  return <dl>{Object.entries(value).map(([key, entry]) => <div key={key} style={{ marginBottom: 8 }}><dt className="cv__meta">{labelOf(key)}</dt><dd style={{ marginLeft: 0 }}><ReviewValue value={entry} /></dd></div>)}</dl>;
}

/** Approval is a platform control: a merchant template cannot hide part of an action being approved. */
export default function ConfirmationCard({ state, onAction }: { state: Record<string, any>; onAction(name: string, params: Record<string, unknown>): void }) {
  let payload: unknown;
  try { if (typeof state.reviewPayload === 'string' && state.reviewPayload.length <= 64_000) payload = JSON.parse(state.reviewPayload); } catch { /* An incomplete review cannot authorise an action. */ }
  const reviewable = payload !== undefined && payload !== null && typeof payload === 'object';
  const action = reviewable && typeof (payload as any).connector === 'string' && typeof (payload as any).tool === 'string' && (payload as any).arguments && typeof (payload as any).arguments === 'object' ? payload as { connector: string; tool: string; arguments: unknown } : undefined;
  return <section className="cv" aria-label={state.heading || 'Review proposed action'}><div className="cv__body">
    <h3 className="cv__h">{state.heading || 'Review proposed action'}</h3>
    <p>{state.summary}</p>
    {action && <p><strong>{state.reviewSource?.name || labelOf(action.connector)}</strong> · {labelOf(action.tool)}</p>}
    {state.reviewSource && <p role="note" className="cv__meta">{state.reviewSource.sample ? 'Demonstration connection — this approval affects demonstration records only.' : 'Connected source'} · {state.reviewSource.environment}</p>}
    {reviewable ? <div aria-label="Full proposed action"><ReviewValue value={action ? action.arguments : payload} /></div> : <p role="alert">The full proposed action is unavailable. Ask the assistant to prepare it again before approving.</p>}
    {state.pending && <div className="cv__actions"><button type="button" className="cv__btn" disabled={!reviewable} onClick={() => onAction('confirmTool', { confirmationId: state.confirmationId, decision: 'allow' })}>{state.allowLabel || 'Allow'}</button><button type="button" className="cv__btn cv__btn--ghost" onClick={() => onAction('confirmTool', { confirmationId: state.confirmationId, decision: 'deny' })}>{state.denyLabel || 'Not now'}</button></div>}
    {state.outcome && <p role="status">{state.outcome}</p>}
  </div></section>;
}
