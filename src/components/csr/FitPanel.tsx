'use client';

import { useState } from 'react';
import { useCsr } from '@/context/CsrContext';
import { SizeSuggestion } from '@/lib/fit-types';
import { getBrandProfile } from '@/services/fit/brands';

/**
 * The size review.
 *
 * Two things this panel has to earn, or a coach ignores it:
 *
 *   1. Every suggestion shows the sentences that produced it. "Why?" is one
 *      click, not a support ticket.
 *   2. It shows who it looked at and found nothing wrong with, and who it
 *      could not assess at all. A tool that only reports hits looks like it
 *      is guessing.
 *
 * Nothing here changes a size on its own — accepting is always a click.
 */
export default function FitPanel() {
  const { state, dispatch, openFitSuggestions } = useCsr();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showAll, setShowAll] = useState(false);

  const review = state.fit;
  if (!review) return null;

  const brand = getBrandProfile(state.brandId);
  const decided = review.suggestions.filter(
    s => state.fitAccepted.includes(s.wearerId) || state.fitDismissed.includes(s.wearerId)
  );

  const pct = (n: number) => `${Math.round(n * 100)}%`;

  const Row = ({ s }: { s: SizeSuggestion }) => {
    const accepted = state.fitAccepted.includes(s.wearerId);
    const dismissed = state.fitDismissed.includes(s.wearerId);
    const open = expanded === s.wearerId;

    return (
      <li className={`csr-fit__row${accepted ? ' is-accepted' : ''}${dismissed ? ' is-dismissed' : ''}`}>
        <div className="csr-fit__main">
          <div className="csr-fit__who">
            <span className="csr-fit__name">{s.wearerName}</span>
            <span className={`csr-fit__band csr-fit__band--${s.band}`}>{s.band} confidence</span>
          </div>
          <div className="csr-fit__because">{s.headline}</div>
        </div>

        <div className="csr-fit__move" aria-label={`${s.from} to ${s.to}`}>
          <span className="csr-fit__from">{s.from}</span>
          <span className="csr-fit__arrow" aria-hidden>→</span>
          <span className="csr-fit__to">{s.to}</span>
        </div>

        <div className="csr-fit__acts">
          {accepted ? (
            <span className="csr-chip csr-chip--add">Accepted</span>
          ) : dismissed ? (
            <span className="csr-chip">Kept {s.from}</span>
          ) : (
            <>
              <button
                className="csr-btn csr-btn--tiny csr-btn--accent"
                onClick={() => dispatch({ type: 'ACCEPT_FIT', wearerId: s.wearerId })}
              >
                Accept
              </button>
              <button
                className="csr-btn csr-btn--tiny"
                onClick={() => dispatch({ type: 'DISMISS_FIT', wearerId: s.wearerId })}
              >
                Keep {s.from}
              </button>
            </>
          )}
          <button
            className="csr-fit__why"
            aria-expanded={open}
            onClick={() => setExpanded(open ? null : s.wearerId)}
          >
            {open ? 'Hide' : 'Why?'}
          </button>
        </div>

        {open && (
          <div className="csr-fit__evidence">
            <div className="csr-fit__evhead">
              {pct(s.confidence)} confident · {s.evidence.length}{' '}
              {s.evidence.length === 1 ? 'signal' : 'signals'}
            </div>
            <ul>
              {s.evidence.map(e => (
                <li key={e.signal}>
                  <span className="csr-fit__evlabel">{e.label}</span>
                  <span className="csr-fit__evtext">{e.because}</span>
                  <span className="csr-fit__evdelta">
                    {e.delta > 0 ? `+${e.delta}` : e.delta} size
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </li>
    );
  };

  return (
    <div className="csr-block csr-block--fit">
      <div className="csr-block__head">
        <div>
          <span className="csr-src csr-src--fit">Fit engine</span>
          <h3 className="csr-block__title">Size review</h3>
        </div>
        <div className="csr-block__actions">
          {openFitSuggestions.length > 1 && (
            <button
              className="csr-btn csr-btn--ghost"
              onClick={() => dispatch({ type: 'ACCEPT_ALL_FIT' })}
            >
              Accept all {openFitSuggestions.length}
            </button>
          )}
          <button className="csr-btn csr-btn--ghost" onClick={() => dispatch({ type: 'CLEAR_FIT' })}>
            Close
          </button>
        </div>
      </div>

      <p className="csr-fit__summary">{review.summary}</p>

      {review.suggestions.length > 0 && (
        <ul className="csr-fit__list">
          {openFitSuggestions.map(s => <Row key={s.wearerId} s={s} />)}
          {decided.map(s => <Row key={s.wearerId} s={s} />)}
        </ul>
      )}

      {/* Coverage. Showing the clean lines is what makes the flagged ones credible. */}
      {(review.unchanged.length > 0 || review.skipped.length > 0) && (
        <div className="csr-fit__coverage">
          <button className="csr-fit__why" aria-expanded={showAll} onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Hide' : 'Show'} the other {review.unchanged.length + review.skipped.length}{' '}
            {brand.copy.wearerNounPlural} we checked
          </button>
          {showAll && (
            <ul className="csr-fit__quiet">
              {review.unchanged.map(u => (
                <li key={u.wearerId}>
                  <span className="csr-fit__evlabel">{u.wearerName}</span>
                  <span className="csr-fit__evtext">{u.why}</span>
                </li>
              ))}
              {review.skipped.map(u => (
                <li key={u.wearerId} className="is-skipped">
                  <span className="csr-fit__evlabel">{u.wearerName}</span>
                  <span className="csr-fit__evtext">{u.why}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {review.policyNotes.length > 0 && (
        <div className="csr-fit__policy">
          {review.policyNotes.map(n => <span key={n}>{n}</span>)}
        </div>
      )}
    </div>
  );
}
