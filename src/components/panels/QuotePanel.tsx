'use client';

import { useJourney } from '@/context/JourneyContext';
import { FINISHES, DEFAULT_ADDONS, formatAUD } from '@/lib/types';

export default function QuotePanel() {
  const { state, dispatch, bom, totals, quoteTitle, handleApprove, handleTryRemove, approving, quoteError } = useJourney();
  const { qty, finish, selectedAddons } = state;

  return (
    <>
      <div className="quote-panel">
        {/* Header */}
        <div className="quote-header">
          <div>
            <div className="quote-header__eyebrow">
              Project Quote · Live {state.jobId ? `· Job ID: ${state.jobId}` : ''}
            </div>
            <h2 className="quote-header__heading">{quoteTitle}</h2>
          </div>
          <div className="quote-header__badge">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="#4E7C59" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="quote-header__badge-text">Compatibility validated</span>
          </div>
        </div>
        <p className="quote-desc">Edit anything below — quantities, finish, extras. I re-validate and re-price as you go.</p>

        {/* Job Details Section */}
        {(state.installationSummary || state.warrantySummary) && (
          <div className="job-details-section" style={{ backgroundColor: '#fff', padding: '16px', borderRadius: '8px', marginBottom: '24px', border: '1px solid #E5E1D9' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: '#17140F', marginBottom: '12px' }}>Job Scope & Guidelines</h3>
            
            {state.installationSummary && (
              <div style={{ marginBottom: '12px' }}>
                <strong style={{ fontSize: '13px', color: '#4E7C59', display: 'block', marginBottom: '4px' }}>Installation Guidelines:</strong>
                <p style={{ fontSize: '13px', color: '#6A645A', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{state.installationSummary}</p>
              </div>
            )}
            
            {state.warrantySummary && (
              <div>
                <strong style={{ fontSize: '13px', color: '#4E7C59', display: 'block', marginBottom: '4px' }}>Warranty & Compliance:</strong>
                <p style={{ fontSize: '13px', color: '#6A645A', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{state.warrantySummary}</p>
              </div>
            )}
          </div>
        )}

        {/* Finish selector */}
        <div className="finish-selector">
          <div>
            <div className="finish-selector__label">Finish</div>
            <div className="finish-selector__value">{finish}</div>
          </div>
          <div className="finish-swatches">
            {FINISHES.map(f => (
              <button
                key={f.name}
                className={`finish-swatch ${finish === f.name ? 'finish-swatch--selected' : ''}`}
                onClick={() => dispatch({ type: 'SET_FINISH', finish: f.name })}
                title={f.name}
              >
                <span
                  className="finish-swatch__dot"
                  style={{ background: f.hex }}
                />
                {f.name}
              </button>
            ))}
          </div>
        </div>

        {/* Quantity stepper */}
        <div className="qty-selector">
          <div>
            <div className="qty-selector__label">Quantity</div>
            <div className="qty-selector__desc">How many bathrooms — each gets its own in-wall parts</div>
          </div>
          <div className="qty-stepper">
            <button className="qty-stepper__btn" onClick={() => dispatch({ type: 'SET_QTY', qty: qty - 1 })}>−</button>
            <div className="qty-stepper__value">{qty}</div>
            <button className="qty-stepper__btn" onClick={() => dispatch({ type: 'SET_QTY', qty: qty + 1 })}>+</button>
          </div>
        </div>

        {/* BOM */}
        <div className="bom-label">Bill of materials</div>
        <div className="bom-table">
          {bom.map((line, i) => (
            <div
              key={`${line.key}-${i}`}
              className={`bom-row ${line.required ? 'bom-row--auto' : ''}`}
            >
              <div className="bom-row__image">
                {line.imageUrl ? (
                  <img src={line.imageUrl} alt={line.name} />
                ) : (
                  <span>{line.category || 'Product'}</span>
                )}
              </div>
              <div className="bom-row__info">
                <div className="bom-row__name-row">
                  <span className="bom-row__name">{line.name}</span>
                  {line.required && (
                    <span className="bom-row__auto-badge">Auto-added · required</span>
                  )}
                </div>
                <div className="bom-row__spec">{line.spec}</div>
                <div className="bom-row__meta">
                  {line.sku && <span className="bom-row__sku">SKU {line.sku}</span>}
                  <span className="bom-row__stock" style={{ color: line.stock.color }}>
                    <span className="bom-row__stock-dot" style={{ background: line.stock.color }} />
                    {line.stock.label}
                  </span>
                </div>
              </div>
              <div className="bom-row__pricing">
                <div className="bom-row__total">{formatAUD(line.lineTotal)}</div>
                <div className="bom-row__unit">{formatAUD(line.price)} × {qty}</div>
                {line.required && (
                  <button className="bom-row__remove" onClick={handleTryRemove}>remove</button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Optional add-ons */}
        <div className="bom-label">Optional for this project</div>
        <div className="addons-section">
          {DEFAULT_ADDONS.map(addon => {
            const isSelected = selectedAddons.includes(addon.id);
            return (
              <div
                key={addon.id}
                className={`addon-card ${isSelected ? 'addon-card--selected' : ''}`}
                onClick={() => dispatch({ type: 'TOGGLE_ADDON', id: addon.id })}
              >
                <div className="addon-card__check">
                  {isSelected && (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
                      <path d="M5 13l4 4L19 7" stroke="#F7F4EE" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="addon-card__name">{addon.name}</div>
                  <div className="addon-card__desc">{addon.desc}</div>
                </div>
                <div className="addon-card__price">{formatAUD(addon.price)}/ea</div>
              </div>
            );
          })}
        </div>

        {/* Insight strip */}
        <div className="insight-strip">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="#17140F" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          <span>
            <b>Live pricing.</b> The shower shows current RRP from caroma.com — EasySwitch keeps the rough-in finish-flexible, so one in-wall body serves any finish.
          </span>
        </div>
      </div>

      {/* Sticky footer */}
      <div className="quote-footer">
        <div className="quote-footer__inner">
          <div className="quote-footer__totals">
            <div>
              <div className="quote-footer__item-label">Subtotal</div>
              <div className="quote-footer__item-value">{formatAUD(totals.subtotal)}</div>
            </div>
            <div>
              <div className="quote-footer__item-label">Discount</div>
              <div className="quote-footer__item-value" style={{ color: '#4E7C59' }}>−{formatAUD(totals.discount)}</div>
            </div>
            <div>
              <div className="quote-footer__item-label">GST</div>
              <div className="quote-footer__item-value">{formatAUD(totals.gst)}</div>
            </div>
            <div>
              <div className="quote-footer__total-label">Total ex-freight</div>
              <div className="quote-footer__total-value">{formatAUD(totals.total)}</div>
            </div>
          </div>
          <div className="quote-footer__actions">
            <button
              className="btn-download"
              onClick={() => dispatch({ type: 'ADD_MESSAGE', role: 'ai', text: 'BOM spec sheet exported — every SKU, finish code and dimension is included for the plumber on site.' })}
            >
              Download BOM
            </button>
            <button className="btn-approve" onClick={handleApprove} disabled={approving}>
              {approving ? 'Confirming price…' : 'Approve & convert to order'}
              {!approving && (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
                  <path d="M4 12h13M11 5l7 7-7 7" stroke="#F7F4EE" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          {quoteError && <p className="quote-footer__error" role="alert">{quoteError}</p>}
        </div>
      </div>
    </>
  );
}
