'use client';

import { useMemo, useState } from 'react';
import { SizeSuggestion, Wearer } from '@/lib/fit-types';
import { reviewSizes } from '@/services/fit/engine';
import { getBrandProfile } from '@/services/fit/brands';
import {
  ALL_SIGNAL_IDS, DEMO_SCENARIOS, SIGNAL_LABELS, getScenario,
} from '@/services/fit/demo-scenarios';

/**
 * One engine, two brands.
 *
 * The point of this screen is the toggle. Everything below it — the wearers,
 * the evidence, the failure mode, the answers — changes completely, and the
 * only thing that changed in the code is which entry in brands.ts was read.
 */
export default function FitDemo() {
  const [scenarioId, setScenarioId] = useState(DEMO_SCENARIOS[0].id);
  const [sizes, setSizes] = useState<Record<string, string>>({});
  const [decided, setDecided] = useState<Record<string, 'accepted' | 'kept'>>({});
  const [expanded, setExpanded] = useState<string | null>(null);

  const scenario = getScenario(scenarioId);
  const brand = getBrandProfile(scenario.brandId);

  const review = useMemo(
    () => reviewSizes({
      brand,
      wearers: scenario.wearers,
      style: scenario.style,
      defaultSizedAt: scenario.defaultSizedAt,
    }),
    [brand, scenario]
  );

  const switchTo = (id: string) => {
    setScenarioId(id);
    setSizes({});
    setDecided({});
    setExpanded(null);
  };

  const accept = (s: SizeSuggestion) => {
    setSizes(prev => ({ ...prev, [s.wearerId]: s.to }));
    setDecided(prev => ({ ...prev, [s.wearerId]: 'accepted' }));
  };
  const keep = (s: SizeSuggestion) =>
    setDecided(prev => ({ ...prev, [s.wearerId]: 'kept' }));

  const acceptAll = () => {
    const open = review.suggestions.filter(s => !decided[s.wearerId]);
    setSizes(prev => ({ ...prev, ...Object.fromEntries(open.map(s => [s.wearerId, s.to])) }));
    setDecided(prev => ({ ...prev, ...Object.fromEntries(open.map(s => [s.wearerId, 'accepted' as const])) }));
  };

  const openCount = review.suggestions.filter(s => !decided[s.wearerId]).length;
  const currentSize = (w: Wearer) => sizes[w.id] ?? w.size;
  const suggestionFor = (id: string) => review.suggestions.find(s => s.wearerId === id);

  return (
    <div className="fitd">
      {/* ── Brand toggle ─────────────────────────────────────────────── */}
      <div className="fitd__tabs" role="tablist" aria-label="Brand">
        {DEMO_SCENARIOS.map(s => (
          <button
            key={s.id}
            role="tab"
            aria-selected={s.id === scenarioId}
            className={`fitd__tab${s.id === scenarioId ? ' is-on' : ''}`}
            onClick={() => switchTo(s.id)}
          >
            {s.tab}
          </button>
        ))}
        <span className="fitd__tabnote">Same engine. Same call. Different profile.</span>
      </div>

      <div className="fitd__grid">
        {/* ── Left: what makes this brand different ──────────────────── */}
        <aside className="fitd__side">
          <div className="csr-block">
            <div className="csr-block__head">
              <div>
                <span className="csr-src csr-src--fit">brands.ts</span>
                <h3 className="csr-block__title">{brand.brandName}</h3>
              </div>
            </div>

            <div className="fitd__label">Signals switched on</div>
            <ul className="fitd__signals">
              {ALL_SIGNAL_IDS.map(id => {
                const weight = brand.signals[id as keyof typeof brand.signals];
                const on = !!weight;
                return (
                  <li key={id} className={on ? 'is-on' : 'is-off'}>
                    <span className="fitd__sigmark" aria-hidden>{on ? '●' : '○'}</span>
                    <span className="fitd__signame">{SIGNAL_LABELS[id]}</span>
                    <span className="fitd__sigweight">{on ? weight!.toFixed(1) : 'off'}</span>
                  </li>
                );
              })}
            </ul>

            <div className="fitd__label">Policy</div>
            <dl className="csr-kv">
              <div>
                <dt>Body measurements</dt>
                <dd>{brand.policy.allowBodyMeasurement && !brand.policy.assumeMinors ? 'Permitted' : 'Never used'}</dd>
              </div>
              <div><dt>Wearers are minors</dt><dd>{brand.policy.assumeMinors ? 'Assumed' : 'No'}</dd></div>
              <div><dt>Largest move</dt><dd>{brand.policy.maxStep} size</dd></div>
              <div><dt>Speaks above</dt><dd>{Math.round(brand.policy.minConfidence * 100)}%</dd></div>
              <div><dt>Applies changes</dt><dd>{brand.policy.autoApply ? 'Automatically' : 'Only when accepted'}</dd></div>
            </dl>
          </div>

          <div className="csr-block fitd__cost">
            <div className="fitd__label">What a wrong size costs here</div>
            <p>{scenario.costOfError}</p>
          </div>
        </aside>

        {/* ── Right: the data, then the answer ───────────────────────── */}
        <main className="fitd__main">
          <div className="csr-block">
            <div className="csr-block__head">
              <div>
                <h2 className="csr-order__title">{scenario.title}</h2>
                <div className="csr-order__sub">{scenario.subtitle}</div>
              </div>
              <span className="csr-pill">{scenario.styleLabel}</span>
            </div>

            <div className="fitd__label">What we already hold on each {brand.copy.wearerNoun}</div>
            <div className="fitd__scroll">
              <table className="fitd__table">
                <thead>
                  <tr>
                    <th>{brand.copy.wearerNoun}</th>
                    <th>Size</th>
                    {scenario.columns.map(c => <th key={c.key}>{c.label}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {/* Iterate the originals so `w.size` stays the size we started
                      with — that is what the accepted size is struck through against. */}
                  {scenario.wearers.map(w => {
                    const s = suggestionFor(w.id);
                    const moved = !!sizes[w.id] && sizes[w.id] !== w.size;
                    return (
                      <tr key={w.id} className={s && !decided[w.id] ? 'is-flagged' : ''}>
                        <td className="fitd__name">{w.name}</td>
                        <td className="fitd__size">
                          {moved ? (
                            <>
                              <span className="csr-fit__from">{w.size}</span>
                              {' '}<span className="csr-fit__to">{sizes[w.id]}</span>
                            </>
                          ) : currentSize(w)}
                        </td>
                        {scenario.columns.map(c => (
                          <td key={c.key} className="fitd__cell">{c.get(w)}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* The review — same output shape for both brands */}
          <div className="csr-block csr-block--fit">
            <div className="csr-block__head">
              <div>
                <span className="csr-src csr-src--fit">Fit engine</span>
                <h3 className="csr-block__title">Size review</h3>
              </div>
              {openCount > 1 && (
                <button className="csr-btn csr-btn--ghost" onClick={acceptAll}>
                  Accept all {openCount}
                </button>
              )}
            </div>

            <p className="csr-fit__summary">{review.summary}</p>

            <ul className="csr-fit__list">
              {review.suggestions.map(s => {
                const state = decided[s.wearerId];
                const open = expanded === s.wearerId;
                return (
                  <li
                    key={s.wearerId}
                    className={`csr-fit__row${state === 'accepted' ? ' is-accepted' : ''}${state === 'kept' ? ' is-dismissed' : ''}`}
                  >
                    <div className="csr-fit__main">
                      <div className="csr-fit__who">
                        <span className="csr-fit__name">{s.wearerName}</span>
                        <span className={`csr-fit__band csr-fit__band--${s.band}`}>{s.band} confidence</span>
                      </div>
                      <div className="csr-fit__because">{s.headline}</div>
                    </div>

                    <div className="csr-fit__move">
                      <span className="csr-fit__from">{s.from}</span>
                      <span className="csr-fit__arrow" aria-hidden>→</span>
                      <span className="csr-fit__to">{s.to}</span>
                    </div>

                    <div className="csr-fit__acts">
                      {state === 'accepted' ? (
                        <span className="csr-chip csr-chip--add">Accepted</span>
                      ) : state === 'kept' ? (
                        <span className="csr-chip">Kept {s.from}</span>
                      ) : (
                        <>
                          <button className="csr-btn csr-btn--tiny csr-btn--accent" onClick={() => accept(s)}>
                            Accept
                          </button>
                          <button className="csr-btn csr-btn--tiny" onClick={() => keep(s)}>
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
                          {Math.round(s.confidence * 100)}% confident · {s.evidence.length}{' '}
                          {s.evidence.length === 1 ? 'signal' : 'signals'}
                        </div>
                        <ul>
                          {s.evidence.map(e => (
                            <li key={e.signal}>
                              <span className="csr-fit__evlabel">{e.label}</span>
                              <span className="csr-fit__evtext">{e.because}</span>
                              <span className="csr-fit__evdelta">{e.delta > 0 ? `+${e.delta}` : e.delta} size</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>

            {(review.unchanged.length > 0 || review.skipped.length > 0) && (
              <div className="csr-fit__coverage">
                <div className="fitd__label">
                  Also checked, nothing to raise
                </div>
                <ul className="csr-fit__quiet">
                  {[...review.unchanged, ...review.skipped].map(u => (
                    <li key={u.wearerId}>
                      <span className="csr-fit__evlabel">{u.wearerName}</span>
                      <span className="csr-fit__evtext">{u.why}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="csr-fit__policy">
              {review.policyNotes.map(n => <span key={n}>{n}</span>)}
              <span>
                Signals that fired: {review.signalsUsed.map(s => SIGNAL_LABELS[s]).join(', ') || 'none'}
              </span>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
