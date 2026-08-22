'use client';

import { useCsr } from '@/context/CsrContext';
import { formatUSD, statusLabel, subStateTone } from '@/lib/csr-types';
import { getAccount } from '@/services/csr/mock-data';
import RosterEditor from './RosterEditor';
import ValidationRail from './ValidationRail';
import FitPanel from './FitPanel';

// Every block is labelled with the system a CSR would visit today to get it.
// Servicing one reorder currently means moving between all five.
function Src({ system }: { system: 'COMS' | 'Commerce' | 'Builder' | 'ERP' | 'Email' }) {
  const cls = system.toLowerCase();
  const label = system === 'Builder' ? 'FreeStyle Builder' : system === 'ERP' ? 'ERP / M3' : system;
  return <span className={`csr-src csr-src--${cls}`}>{label}</span>;
}

// ── Empty state ────────────────────────────────────────────────────────
function StartHere() {
  const { dispatch } = useCsr();
  const examples = [
    'oswego east volleyball',
    'cloud 9 baseball',
    'S499204',
    'OE-VB-2025',
  ];
  return (
    <div className="csr-start">
      <h2 className="csr-start__title">Find the order</h2>
      <p className="csr-start__desc">
        Type whatever the caller just told you — a school, a dealer, a sport, an S number,
        a PO. You do not need the reference number.
      </p>
      <div className="csr-start__examples">
        {examples.map(e => (
          <button key={e} className="csr-example" onClick={() => dispatch({ type: 'SEARCH', query: e })}>
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Results ────────────────────────────────────────────────────────────
function Results() {
  const { state, dispatch } = useCsr();
  if (!state.hits.length) {
    return (
      <div className="csr-start">
        <h2 className="csr-start__title">Nothing found</h2>
        <p className="csr-start__desc">No order matches “{state.query}”. Try the school, the dealer or the sport.</p>
      </div>
    );
  }
  return (
    <div className="csr-results">
      <div className="csr-results__head">
        {state.hits.length} {state.hits.length === 1 ? 'order' : 'orders'} for “{state.query}”
      </div>
      {state.hits.map(h => {
        const o = h.order;
        return (
          <button key={o.comsId} className="csr-hit" onClick={() => dispatch({ type: 'OPEN_ORDER', sNumber: o.sNumber })}>
            <div className="csr-hit__main">
              <div className="csr-hit__top">
                <span className="csr-hit__s">{o.sNumber}</span>
                <span className={`csr-pill csr-pill--${subStateTone(o.subState)}`}>{statusLabel(o)}</span>
                {o.orderSubType === 'MOCK_ONLY' && <span className="csr-pill csr-pill--mock">MOCK ONLY</span>}
              </div>
              <div className="csr-hit__acct">{o.accountName}</div>
              <div className="csr-hit__meta">
                {o.sport} · {o.season} · {o.product.styleId} · {o.roster.length} units
              </div>
            </div>
            <div className="csr-hit__side">
              <div className="csr-hit__matched">matched on {h.matchedOn}</div>
              <div className="csr-hit__val">{formatUSD(o.roster.length * o.product.unitPrice)}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ── Order ──────────────────────────────────────────────────────────────
function OrderView() {
  const { state, dispatch } = useCsr();
  const draft = state.draft;
  if (!draft) return null;
  const acct = getAccount(draft.acctNumber);

  return (
    <div className="csr-order">
      <div className="csr-order__main">
        <button className="csr-back" onClick={() => dispatch({ type: 'BACK_TO_RESULTS' })}>← Results</button>

        {/* Identity */}
        <div className="csr-block csr-block--head">
          <div className="csr-block__head">
            <div>
              <Src system="Commerce" />
              <h2 className="csr-order__title">{draft.accountName}</h2>
              <div className="csr-order__sub">
                {acct?.accountType} · {acct?.city}, {acct?.state} · Rep {draft.salesRepName}
                {acct?.contactName ? ` · ${acct.contactName}` : ''}
              </div>
            </div>
            <div className="csr-order__ids">
              <div><span>S number</span><strong>{draft.sNumber}</strong></div>
              {draft.poNumber && <div><span>PO</span><strong>{draft.poNumber}</strong></div>}
              <div><span>Account</span><strong>{draft.acctNumber}</strong></div>
            </div>
          </div>
        </div>

        {/* Design */}
        <div className="csr-block">
          <div className="csr-block__head">
            <div>
              <Src system="Builder" />
              <h3 className="csr-block__title">Design</h3>
            </div>
            <span className={`csr-pill csr-pill--${draft.product.stillAvailable ? 'good' : 'bad'}`}>
              {draft.product.stillAvailable ? 'Available' : 'Discontinued'}
            </span>
          </div>
          <div className="csr-design">
            <div className="csr-design__swatch" aria-hidden>{draft.product.styleId.slice(0, 3)}</div>
            <div className="csr-design__body">
              <div className="csr-design__name">{draft.product.styleName}</div>
              <dl className="csr-kv">
                <div><dt>Style</dt><dd>{draft.product.styleId}</dd></div>
                <div><dt>Colourway</dt><dd>{draft.product.colorway}</dd></div>
                <div><dt>Unit price</dt><dd>{formatUSD(draft.product.unitPrice)}</dd></div>
                <div><dt>Art type</dt><dd>{draft.artTypes.join(', ') || '—'}</dd></div>
              </dl>
            </div>
          </div>
        </div>

        {/* Art / production status */}
        <div className="csr-block">
          <div className="csr-block__head">
            <div>
              <Src system="COMS" />
              <h3 className="csr-block__title">Art &amp; production</h3>
            </div>
            <span className={`csr-pill csr-pill--${subStateTone(draft.subState)}`}>{statusLabel(draft)}</span>
          </div>
          <dl className="csr-kv csr-kv--wide">
            <div><dt>Order type</dt><dd>{draft.orderType} · {draft.orderSubType}</dd></div>
            <div><dt>Proofs</dt><dd>{draft.proofsReady} ready of {draft.proofsRequested} requested</dd></div>
            <div><dt>Revisions</dt><dd>{draft.revisionCount}</dd></div>
            <div><dt>Assignee</dt><dd>{draft.assignee || 'Unassigned'}</dd></div>
            <div><dt>Received</dt><dd>{draft.receivedDate}</dd></div>
            <div><dt>Hold</dt><dd>{draft.hold ? 'Yes' : 'No'}</dd></div>
          </dl>
          {draft.tags.length > 0 && (
            <div className="csr-tags">
              {draft.tags.map(t => (
                <span key={t} className={`csr-tag ${/reject|unresponsive|pms|neon/i.test(t) ? 'csr-tag--flag' : ''}`}>{t}</span>
              ))}
            </div>
          )}
        </div>

        <RosterEditor />
        <FitPanel />

        {/* History — what the CSR would otherwise dig out of email */}
        {draft.notes && draft.notes.length > 0 && (
          <div className="csr-block">
            <div className="csr-block__head">
              <div>
                <Src system="Email" />
                <h3 className="csr-block__title">History</h3>
              </div>
            </div>
            <ul className="csr-notes">
              {draft.notes.map((n, i) => (
                <li key={i}>
                  <span className="csr-notes__meta">{n.at} · {n.who}</span>
                  <span className="csr-notes__text">{n.text}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <ValidationRail />
    </div>
  );
}

// ── Submitted ──────────────────────────────────────────────────────────
function Submitted() {
  const { state, dispatch, checks } = useCsr();
  // Report the proof decision the workspace actually made, rather than
  // assuming the happy path — a style or colour change does need an artist.
  const proof = checks.find(c => c.id === 'proof');
  return (
    <div className="csr-start">
      <div className="csr-done" aria-hidden>{state.handedOff ? '→' : '✓'}</div>
      <h2 className="csr-start__title">
        {state.handedOff ? 'Handed off to art' : `Reorder submitted — ${state.submittedRef}`}
      </h2>
      <p className="csr-start__desc">
        {state.handedOff
          ? state.lastAction || 'An artist will pick this up from the queue.'
          : proof?.level === 'warn'
            ? `Queued for a new proof — ${proof.detail.toLowerCase()}`
            : 'Approved artwork reused. No new proof was required.'}
      </p>
      <button className="csr-btn csr-btn--primary" onClick={() => dispatch({ type: 'RESET' })}>
        Next call
      </button>
    </div>
  );
}

export default function CsrWorkspace() {
  const { state } = useCsr();
  return (
    <div className="csr-workspace">
      {state.phase === 'search' && <StartHere />}
      {state.phase === 'results' && <Results />}
      {state.phase === 'order' && <OrderView />}
      {state.phase === 'submitted' && <Submitted />}
    </div>
  );
}
