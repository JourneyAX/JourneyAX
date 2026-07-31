'use client';

import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

/**
 * RetailCartPanel — the B2C closing surface (commerceMode === 'cart').
 *
 * A DELIBERATELY SEPARATE component from QuotePanel. A retail fashion/candy
 * brand is not a fixtures project: there is no finish swatch, no "how many
 * bathrooms" stepper, no bill of materials, no plumbing add-ons, no warranty
 * line, and — critically — no "quote". This is a shopping bag: items with their
 * size/variant and quantity, a subtotal + tax, and a Checkout button.
 *
 * It reuses the SAME journey plumbing as the quote path (bom, totals,
 * handleApprove → the authoritative server order + Stripe checkout), so payment
 * behaves identically; only the presentation is retail. Caroma's QuotePanel is
 * never touched — the two surfaces are picked by config in ProjectPanel.
 */
export default function RetailCartPanel() {
  const { state, dispatch, bom, totals, quoteTitle, handleApprove } = useJourney();
  const cfg = useStorefrontConfig();
  const ordering = !!state.ordering;
  const orderError = state.orderError;
  const warnings = state.serverQuote?.validation?.warnings || [];
  const canOrder = !state.serverQuote || state.serverQuote.validation.ok;

  // Money in the quote's OWN currency (A&F = USD $). A real $0 (e.g. a zero
  // discount) reads as zero; a genuinely unknown price reads "Price on request".
  const symbol = state.serverQuote?.symbol || '$';
  const money = (n: number | null | undefined, { zeroIsReal = false } = {}): string => {
    if (n === null || n === undefined || Number.isNaN(n)) return 'Price on request';
    if (n === 0 && !zeroIsReal) return 'Price on request';
    // Show the EXACT amount, cents and all — a retail customer must see the same
    // number Stripe will charge ($517.05, not a rounded $517). Whole values stay
    // clean ($80, not $80.00); anything with cents shows them.
    const whole = Number.isInteger(n);
    return symbol + n.toLocaleString('en-US', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 });
  };

  const itemCount = bom.reduce((sum, l) => sum + (l.quantity ?? 1), 0);

  return (
    <>
      <div className="quote-panel">
        {/* Header — retail language, no "quote"/"job id". */}
        <div className="quote-header">
          <div>
            <div className="quote-header__eyebrow">Your Bag · {itemCount} {itemCount === 1 ? 'item' : 'items'}</div>
            <h2 className="quote-header__heading">{quoteTitle || 'Your look'}</h2>
          </div>
          <div className="quote-header__badge">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M5 13l4 4L19 7" stroke="var(--success)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span className="quote-header__badge-text">Styled for you</span>
          </div>
        </div>
        <p className="quote-desc">Review your pieces and sizes below — adjust anything in the chat, and I&apos;ll update your bag.</p>

        {/* Items — image, name, size/variant, unit price × qty. No finishes,
            no bathrooms stepper, no BOM label. */}
        <div className="bom-label">Your items</div>
        <div className="bom-table">
          {bom.map((line, i) => (
            <div key={`${line.key}-${i}`} className="bom-row">
              <div className="bom-row__image">
                {line.imageUrl ? (
                  <img src={line.imageUrl} alt={line.name} />
                ) : (
                  <span>{line.category || 'Item'}</span>
                )}
              </div>
              <div className="bom-row__info">
                <div className="bom-row__name-row">
                  <span className="bom-row__name">{line.name}</span>
                </div>
                {line.spec && <div className="bom-row__spec">{line.spec}</div>}
                <div className="bom-row__meta">
                  {line.sku && <span className="bom-row__sku">Style {line.sku}</span>}
                  {line.stock?.label && (
                    <span className="bom-row__stock" style={{ color: line.stock.color }}>
                      <span className="bom-row__stock-dot" style={{ background: line.stock.color }} />
                      {line.stock.label}
                    </span>
                  )}
                </div>
              </div>
              <div className="bom-row__pricing">
                <div className="bom-row__total">{money(line.lineTotal)}</div>
                <div className="bom-row__unit">{money(line.price)} × {line.quantity ?? 1}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Sticky footer — Subtotal / Tax / Total, then Checkout. No GST label,
          no "ex-freight", no "Download BOM", no "Approve & pay". */}
      <div className="quote-footer">
        <div className="quote-footer__inner">
          <div className="quote-footer__totals">
            <div>
              <div className="quote-footer__item-label">Subtotal</div>
              <div className="quote-footer__item-value">{money(totals.subtotal)}</div>
            </div>
            {totals.discount ? (
              <div>
                <div className="quote-footer__item-label">Discount</div>
                <div className="quote-footer__item-value" style={{ color: 'var(--success)' }}>−{money(totals.discount, { zeroIsReal: true })}</div>
              </div>
            ) : null}
            <div>
              <div className="quote-footer__item-label">Tax</div>
              <div className="quote-footer__item-value">{money(totals.gst, { zeroIsReal: true })}</div>
            </div>
            <div>
              <div className="quote-footer__total-label">Total</div>
              <div className="quote-footer__total-value">{money(totals.total)}</div>
            </div>
          </div>
          <div className="quote-footer__actions">
            <button className="btn-approve" onClick={handleApprove} disabled={ordering || !canOrder} style={{ width: '100%' }}>
              {ordering ? 'Starting secure checkout…' : 'Checkout securely'}
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
