'use client';

import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { FINISHES, DEFAULT_ADDONS } from '@/lib/types';

export default function QuotePanel() {
  const { state, dispatch, bom, totals, quoteTitle, handleApprove, handleTryRemove } = useJourney();
  const cfg = useStorefrontConfig();
  const { qty, finish, selectedAddons } = state;
  const ordering = !!state.ordering;
  const orderError = state.orderError;
  const warnings = state.serverQuote?.validation?.warnings || [];
  const canOrder = !state.serverQuote || state.serverQuote.validation.ok;

  /* This panel began as Caroma's bathroom BOM — finish swatches, a "how many
   * bathrooms" stepper, plumbing add-ons, GST. None of that belongs on a team
   * kit OR on personalised candy. Those controls are FIXTURES-ONLY, so they show
   * only for a fixtures tenant (Caroma has no configurator, or productType
   * 'fixtures') and disappear for every other vertical — garment (Augusta),
   * candy (M&M'S) and anything added later. The old test `!== 'garment'` wrongly
   * swept candy into the bathroom bucket, so M&M'S saw finishes + "how many
   * bathrooms" + a basin dress ring. */
  const productType = cfg.configurator?.productType;
  const isFixtures = !productType || productType === 'fixtures';

  /* Money is formatted in the quote's OWN currency — the authoritative quote
   * carries its symbol (USD for Augusta), so a US-priced cap must never be shown
   * with an A$. A genuinely unknown price reads "Price on request"; a real zero
   * (a $0 discount) reads as zero, not as unknown. */
  const symbol = state.serverQuote?.symbol || '$';
  const money = (n: number | null | undefined, { zeroIsReal = false } = {}): string => {
    if (n === null || n === undefined || Number.isNaN(n)) return 'Price on request';
    if (n === 0 && !zeroIsReal) return 'Price on request';
    return symbol + Math.round(n).toLocaleString('en-US');
  };
  const taxLabel = isFixtures ? 'GST' : 'Tax';

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
              <path d="M5 13l4 4L19 7" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="quote-header__badge-text">Compatibility validated</span>
          </div>
        </div>
        <p className="quote-desc">Edit anything below — {isFixtures ? 'quantities, finish, extras' : 'quantities and options'}. I re-validate and re-price as you go.</p>

        {/* Job Details Section */}
        {(state.installationSummary || state.warrantySummary) && (
          <div className="job-details-section" style={{ backgroundColor: 'var(--surface)', padding: '16px', borderRadius: '8px', marginBottom: '24px', border: '1px solid #E5E1D9' }}>
            <h3 style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text)', marginBottom: '12px' }}>Job Scope & Guidelines</h3>
            
            {state.installationSummary && (
              <div style={{ marginBottom: '12px' }}>
                <strong style={{ fontSize: '13px', color: 'var(--success)', display: 'block', marginBottom: '4px' }}>{isFixtures ? 'Installation Guidelines:' : 'Order details:'}</strong>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{state.installationSummary}</p>
              </div>
            )}
            
            {state.warrantySummary && (
              <div>
                <strong style={{ fontSize: '13px', color: 'var(--success)', display: 'block', marginBottom: '4px' }}>Warranty & Compliance:</strong>
                <p style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5, whiteSpace: 'pre-wrap' }}>{state.warrantySummary}</p>
              </div>
            )}
          </div>
        )}

        {/* Finish selector — a fixtures concept (plumbing finish). A garment's
            colour/design is chosen on the model, not here. */}
        {isFixtures && (
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
        )}

        {/* Quantity stepper — one "bathrooms" quantity is a fixtures notion. A
            kit's quantities are per line (per size, from the roster), so the
            single stepper is hidden and each line shows its own quantity. */}
        {isFixtures && (
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
        )}

        {/* Line items */}
        <div className="bom-label">{isFixtures ? 'Bill of materials' : 'Your items'}</div>
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
                {/* Each line carries its OWN quantity — a server quote prices per
                    size, so the row must not multiply by a single global qty. */}
                <div className="bom-row__total">{money(line.lineTotal)}</div>
                <div className="bom-row__unit">{money(line.price)} × {line.quantity ?? qty}</div>
                {line.required && isFixtures && (
                  <button className="bom-row__remove" onClick={handleTryRemove}>remove</button>
                )}
              </div>
            </div>
          ))}
        </div>

        {/* Optional add-ons — the defaults are Caroma plumbing extras (dress
            ring, towel rail, Caroma Care). Shown only for a fixtures tenant;
            a kit's extras come from the agent as real line items. */}
        {isFixtures && (
        <div>
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
                      <path d="M5 13l4 4L19 7" stroke="var(--surface)" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </div>
                <div style={{ flex: 1 }}>
                  <div className="addon-card__name">{addon.name}</div>
                  <div className="addon-card__desc">{addon.desc}</div>
                </div>
                <div className="addon-card__price">{money(addon.price)}/ea</div>
              </div>
            );
          })}
        </div>
        </div>
        )}

        {/* Insight strip — Caroma-specific copy (EasySwitch, caroma.com RRP). */}
        {isFixtures && (
          <div className="insight-strip">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" stroke="var(--text)" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>
              <b>Live pricing.</b> The shower shows current RRP from caroma.com — EasySwitch keeps the rough-in finish-flexible, so one in-wall body serves any finish.
            </span>
          </div>
        )}
      </div>

      {/* Sticky footer */}
      <div className="quote-footer">
        <div className="quote-footer__inner">
          <div className="quote-footer__totals">
            <div>
              <div className="quote-footer__item-label">Subtotal</div>
              <div className="quote-footer__item-value">{money(totals.subtotal)}</div>
            </div>
            <div>
              <div className="quote-footer__item-label">Discount</div>
              {/* A real $0 discount is zero, not "price on request". */}
              <div className="quote-footer__item-value" style={{ color: 'var(--success)' }}>−{money(totals.discount, { zeroIsReal: true })}</div>
            </div>
            <div>
              <div className="quote-footer__item-label">{taxLabel}</div>
              <div className="quote-footer__item-value">{money(totals.gst, { zeroIsReal: true })}</div>
            </div>
            <div>
              <div className="quote-footer__total-label">{isFixtures ? 'Total ex-freight' : 'Total'}</div>
              <div className="quote-footer__total-value">{money(totals.total)}</div>
            </div>
          </div>
          {state.leadTimeSummary && (
            <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: '10px 0 0', lineHeight: 1.5 }}>
              {state.leadTimeSummary}
            </p>
          )}
          <div className="quote-footer__actions">
            <button
              className="btn-download"
              onClick={() => dispatch({ type: 'ADD_MESSAGE', role: 'ai', text: isFixtures
                ? 'BOM spec sheet exported — every SKU, finish code and dimension is included for the plumber on site.'
                : 'Spec sheet exported — every SKU, size and quantity is included for your order.' })}
            >
              {isFixtures ? 'Download BOM' : 'Download spec sheet'}
            </button>
            <button className="btn-approve" onClick={handleApprove} disabled={ordering || !canOrder}>
              {ordering ? 'Starting secure checkout…' : 'Approve & pay securely'}
              {!ordering && (
                <svg width="17" height="17" viewBox="0 0 24 24" fill="none" style={{ marginLeft: 9 }}>
                  <path d="M4 12h13M11 5l7 7-7 7" stroke="var(--surface)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
          </div>
          {(orderError || warnings.length > 0) && (
            <div style={{ marginTop: 10, fontSize: 12.5 }}>
              {orderError && <div style={{ color: '#B00020', fontWeight: 700 }}>{orderError}</div>}
              {warnings.map((w, i) => (
                <div key={i} style={{ color: 'var(--warning)' }}>⚠ {w}</div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

