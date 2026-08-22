'use client';

import { useCsr } from '@/context/CsrContext';
import { formatUSD } from '@/lib/csr-types';

/**
 * The checks that decide whether this reorder can go straight through.
 *
 * The one that matters most is the proof decision: a roster-only change reuses
 * approved artwork and never needs an artist, while a colour or style change
 * does. Getting that wrong either creates art work nobody needed or ships
 * something unapproved.
 */
export default function ValidationRail() {
  const { state, checks, blockers, canSubmit, orderValue, diff, dispatch } = useCsr();
  const draft = state.draft;
  if (!draft) return null;

  const icon = (level: string) => (level === 'ok' ? '✓' : level === 'warn' ? '!' : '×');

  return (
    <aside className="csr-rail">
      <div className="csr-rail__section">
        <h3 className="csr-rail__title">Checks</h3>
        <ul className="csr-checks">
          {checks.map(c => (
            <li key={c.id} className={`csr-check csr-check--${c.level}`}>
              <span className="csr-check__icon" aria-hidden>{icon(c.level)}</span>
              <div className="csr-check__body">
                <div className="csr-check__title">{c.title}</div>
                <div className="csr-check__detail">{c.detail}</div>
                {c.action && c.id === 'style' && draft.product.suggestedReplacement && (
                  <button
                    className="csr-btn csr-btn--tiny"
                    onClick={() => dispatch({ type: 'ACCEPT_REPLACEMENT_STYLE' })}
                  >
                    {c.action}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>

      <div className="csr-rail__section">
        <h3 className="csr-rail__title">This order</h3>
        <dl className="csr-facts">
          <div><dt>Units</dt><dd>{draft.roster.length}</dd></div>
          <div><dt>Unit price</dt><dd>{formatUSD(draft.product.unitPrice)}</dd></div>
          <div className="csr-facts__total"><dt>Value</dt><dd>{formatUSD(orderValue)}</dd></div>
        </dl>
        {diff.qtyBefore !== diff.qtyAfter && (
          <p className="csr-hint">
            Previous order was {diff.qtyBefore} units at {formatUSD(diff.qtyBefore * draft.product.unitPrice)}.
          </p>
        )}
      </div>

      <div className="csr-rail__section csr-rail__section--foot">
        {blockers.length > 0 && (
          <p className="csr-blockmsg">
            {blockers.length} {blockers.length === 1 ? 'item' : 'items'} to resolve before this can be submitted.
          </p>
        )}
        <button
          className="csr-btn csr-btn--primary csr-btn--full"
          disabled={!canSubmit}
          onClick={() => dispatch({ type: 'SUBMIT' })}
        >
          Submit reorder
        </button>
        <button
          className="csr-btn csr-btn--ghost csr-btn--full"
          onClick={() => dispatch({ type: 'HAND_OFF', reason: 'Routed to art queue' })}
        >
          Hand off to art
        </button>
      </div>
    </aside>
  );
}
