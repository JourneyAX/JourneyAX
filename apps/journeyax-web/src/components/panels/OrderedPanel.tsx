'use client';

import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { formatAUD } from '@/lib/types';

/**
 * The confirmation, told from the ORDER — not from this browser tab.
 *
 * Payment sends the customer away to Stripe and brings them back on a fresh
 * page load, so the journey state this panel used to read is empty by the time
 * it renders. It showed "Price on request" to someone who had just been charged
 * $161, and listed nothing they had bought. The order is the only thing that
 * survives that round trip, and the only authority on what was actually paid,
 * so everything here comes from it.
 */
export default function OrderedPanel() {
  const { state, totals, handleRestart } = useJourney();
  const cfg = useStorefrontConfig();
  const { orderId, placedOrder } = state;
  // A fixtures tenant validates "bathrooms" with EasySwitch parts; a garment
  // tenant orders a kit. Keep the confirmation in the tenant's own language.
  const isFixtures = !cfg.configurator || cfg.configurator.productType !== 'garment';

  const paid = placedOrder?.status === 'paid';
  const money = (n?: number | null) =>
    typeof n === 'number'
      ? (placedOrder?.symbol ? `${placedOrder.symbol}${n.toFixed(2)}` : formatAUD(n))
      : null;
  // The order's own total when we have it; the in-tab figure is only a fallback
  // for a journey that never left for payment.
  const total = money(placedOrder?.total) ?? formatAUD(totals.total);
  const lines = placedOrder?.lines || [];

  return (
    <div className="ordered-panel">
      <div className="ordered-panel__icon">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none">
          <path d="M5 13l4 4L19 7" stroke="var(--gold-light)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <div className="ordered-panel__eyebrow">
        {paid ? 'Payment received' : 'Order created'} · {placedOrder?.orderId || orderId}
      </div>
      <h2 className="ordered-panel__heading">{paid ? 'You’re all set.' : 'Converted to order.'}</h2>
      <p className="ordered-panel__desc">
        {/* Claim only what actually happened. The previous copy promised a
            confirmation and spec sheet "on the way to your account" — nothing
            sends either, so it was a promise the product does not keep. */}
        {paid
          ? `Payment confirmed and your order is locked in at this price — every item, size and quantity as shown. ${
              placedOrder?.leadTimeSummary
              || 'It moves into production next; quote the order number above with any question.'}`
          : isFixtures
            ? `${state.qty} validated bathroom${state.qty > 1 ? 's' : ''} — every fixture, finish and required EasySwitch in-wall body — locked in at your price.`
            : 'Your order is locked in at your price — every item, size and quantity confirmed.'}
      </p>

      {/* What was bought. A confirmation without the items is a receipt with the
          receipt torn off — it was the first thing missing after payment. */}
      {lines.length > 0 && (
        <div className="ordered-panel__lines">
          {lines.map((l) => (
            <div key={l.sku} className="ordered-panel__line">
              <div className="ordered-panel__line-main">
                <span className="ordered-panel__line-name">{l.name || l.sku}</span>
                <span className="ordered-panel__line-meta">
                  {`SKU ${l.sku}`}{typeof l.quantity === 'number' ? ` · ${l.quantity} ordered` : ''}
                </span>
              </div>
              <span className="ordered-panel__line-total">{money(l.lineTotal) ?? ''}</span>
            </div>
          ))}
        </div>
      )}

      <div className="ordered-panel__total-row">
        <span className="ordered-panel__total-label">
          {paid ? 'Paid' : isFixtures ? 'Order total ex-freight' : 'Order total'}
        </span>
        <span className="ordered-panel__total-value">{total}</span>
      </div>
      <button className="ordered-panel__restart" onClick={handleRestart}>
        Start a new configuration
      </button>
    </div>
  );
}
