'use client';

/**
 * The cart as a working surface in the side panel: every line with its photo, price, quantity and a way to remove it, the totals,
 * and one button that goes on (a last look at the order first when the shop has that on, payment otherwise). Same server-owned
 * data as the drawer it replaces: the quote's lines and totals, never a second copy.
 */
import { useJourney } from '@/context/JourneyContext';
import { useState } from 'react';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { closePanelCard } from '@/lib/shell/sidePanelStore';
import { formatMoney } from './money';

export default function CartCanvas() {
  const { state, bom, totals, requestCheckout, removeFromCart, setQuantity, repriceCart } = useJourney();
  const [repricing, setRepricing] = useState(false);
  const cfg = useStorefrontConfig();
  const symbol = state.serverQuote?.symbol;
  const currency = state.serverQuote?.currency;
  const allUnpriced = bom.length > 0 && bom.every((line) => line.price === null || line.price === 0);
  const money = (amount: number | null | undefined) => formatMoney(amount, symbol, currency, allUnpriced);
  const count = bom.reduce((sum, line) => sum + (line.quantity ?? 1), 0);
  const ordering = !!state.ordering;

  return (
    <div className="cv">
      <div className="cv__body">
        {state.orderError && <div role="alert" className="cv__alert">{state.orderError}{bom.length > 0 && <button type="button" className="cv__link" disabled={repricing || ordering} onClick={() => { setRepricing(true); void repriceCart().catch(() => {}).finally(() => setRepricing(false)); }}>{repricing ? 'Refreshing quote…' : 'Refresh quote'}</button>}</div>}
        {bom.length === 0 ? (
          <div className="cv__empty">
            <p className="cv__empty-title">Nothing in your order yet</p>
            <p className="cv__empty-text">Ask for what you need and add it as you go. It all shows up here.</p>
            <button type="button" className="cv__btn cv__btn--ghost" onClick={() => closePanelCard()}>Keep browsing</button>
          </div>
        ) : (
          <ul className="cv__lines">
            {bom.map((line, index) => (
              <li key={`${line.key}-${index}`} className="cv__line">
                <div className="cv__thumb">{line.imageUrl ? <img src={line.imageUrl} alt="" /> : <span aria-hidden="true">□</span>}</div>
                <div className="cv__info">
                  <div className="cv__name">{line.name}</div>
                  <div className="cv__meta">{line.sku ? `SKU ${line.sku} · ` : ''}{money(line.price)} each</div>
                  {line.stock?.label && <div className="cv__stock" style={{ color: line.stock.color }}>{line.stock.label}</div>}
                  <div className="cv__row">
                    <div className="cv__stepper" role="group" aria-label={`Quantity of ${line.name}`}>
                      <button type="button" onClick={() => { if (line.sku) void setQuantity(line.sku, Math.max(0, (line.quantity ?? 1) - 1)).catch(() => {}); }} aria-label="One fewer">−</button>
                      <span>{line.quantity ?? 1}</span>
                      <button type="button" onClick={() => { if (line.sku) void setQuantity(line.sku, (line.quantity ?? 1) + 1).catch(() => {}); }} aria-label="One more">+</button>
                    </div>
                    {!line.required && <button type="button" className="cv__link" onClick={() => { if (line.sku) void removeFromCart(line.sku).catch(() => {}); }}>Remove</button>}
                  </div>
                </div>
                <div className="cv__total">{money(line.lineTotal ?? (line.price != null ? line.price * (line.quantity ?? 1) : null))}</div>
              </li>
            ))}
          </ul>
        )}
      </div>
      {bom.length > 0 && (
        <footer className="cv__foot">
          <div className="cv__sum"><span>{count} {count === 1 ? 'item' : 'items'}</span><span>{money(totals.subtotal)}</span></div>
          {!!totals.discount && <div className="cv__sum cv__sum--good"><span>Discount</span><span>−{money(totals.discount)}</span></div>}
          {!!totals.gst && <div className="cv__sum"><span>{state.serverQuote?.taxRate != null ? `${Math.round(state.serverQuote.taxRate * 100)}% tax` : 'Tax'}</span><span>{money(totals.gst)}</span></div>}
          <div className="cv__sum cv__sum--grand"><span>Total</span><span>{money(totals.total)}</span></div>
          <button type="button" className="cv__btn cv__btn--primary" onClick={requestCheckout} disabled={ordering || repricing}>
            {ordering ? 'Getting your payment ready…' : cfg.checkoutReview ? 'Check my order and pay' : 'Pay now'}
          </button>
        </footer>
      )}
    </div>
  );
}
