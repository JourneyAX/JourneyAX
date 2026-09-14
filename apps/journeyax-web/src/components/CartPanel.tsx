'use client';

/**
 * CartPanel — persistent Cart/Quote summary column (docs/v3-card-cms-architecture.md,
 * ACME commerce reference). Third column alongside the chat and the stage: unlike
 * QuotePanel/RetailCartPanel (the full-stage review surface a customer navigates
 * INTO), this is a compact sidebar that's always on screen once the journey has
 * real line items, so "what's in my cart/quote" is never a click away.
 *
 * Reuses the exact same server-authoritative data every other closing surface
 * reads (`bom`, `totals`, `handleApprove`) — this is a second VIEW of that data,
 * never a second source of it. A tenant can turn it off via
 * uiTheme.layout.cartPanel: false.
 */
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function CartPanel() {
  const { state, bom, totals, handleApprove } = useJourney();
  const cfg = useStorefrontConfig();
  const isCart = (cfg as any).commerceMode === 'cart';
  const ordering = !!state.ordering;

  const symbol = state.serverQuote?.symbol || '$';
  const currencyCode = state.serverQuote?.currency;
  const money = (n: number | null | undefined): string => {
    if (n === null || n === undefined || Number.isNaN(n)) return 'Price on request';
    return symbol + Math.round(n).toLocaleString('en-US') + (currencyCode ? ` ${currencyCode}` : '');
  };

  const itemCount = bom.reduce((sum, l) => sum + (l.quantity ?? 1), 0);
  const label = isCart ? 'Cart' : 'Quote';

  // Nothing to show yet — hide rather than render an empty shell before the
  // conversation has produced anything worth summarising.
  if (bom.length === 0) return null;

  const removeLine = (sku?: string) => {
    if (!sku) return;
    (window as any).__handleBuildQuote?.(`Remove SKU ${sku} from my ${isCart ? 'bag' : 'quote'}.`);
  };

  return (
    <div className="cart-panel">
      <div className="cart-panel__header">
        <span className="cart-panel__title">{label}</span>
        <span className="cart-panel__count">{itemCount} {itemCount === 1 ? 'item' : 'items'}</span>
      </div>

      <div className="cart-panel__lines">
        {bom.map((line, i) => (
          <div key={`${line.key}-${i}`} className="cart-panel__line">
            <div className="cart-panel__thumb">
              {line.imageUrl ? <img src={line.imageUrl} alt={line.name} /> : <span>📦</span>}
            </div>
            <div className="cart-panel__info">
              <div className="cart-panel__name">{line.name}</div>
              <div className="cart-panel__meta">{money(line.price)}{(line.quantity ?? 1) > 1 ? ` × ${line.quantity}` : ''}</div>
              {line.stock?.label && (
                <div className="cart-panel__stock" style={{ color: line.stock.color }}>{line.stock.label}</div>
              )}
              {!line.required && (
                <button type="button" className="cart-panel__remove" onClick={() => removeLine(line.sku)}>Remove</button>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="cart-panel__footer">
        <div className="cart-panel__totals-row">
          <span>Subtotal</span>
          <span>{money(totals.subtotal)}</span>
        </div>
        {!!totals.discount && (
          <div className="cart-panel__totals-row" style={{ color: 'var(--success)' }}>
            <span>Discount</span>
            <span>−{money(totals.discount)}</span>
          </div>
        )}
        <div className="cart-panel__totals-row cart-panel__totals-row--total">
          <span>Total</span>
          <span>{money(totals.total)}</span>
        </div>
        <button type="button" className="cart-panel__cta" onClick={handleApprove} disabled={ordering}>
          {ordering ? 'Starting checkout…' : isCart ? 'View order summary' : 'Approve & pay securely'}
        </button>
      </div>
    </div>
  );
}
