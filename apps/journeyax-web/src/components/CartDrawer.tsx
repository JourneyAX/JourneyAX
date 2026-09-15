'use client';

/**
 * CartDrawer — the header cart icon's slide-in panel (approved mockup:
 * "PlaceMakers Conversation", https://claude.ai/code/artifact/9eea2471).
 *
 * A second VIEW of the same server-authoritative data every closing surface
 * already reads (`bom`, `totals`, `handleApprove`) — never a second source of
 * it. Opens over the single-column conversation; the conversation itself
 * never resizes to make room for it.
 */
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';

export default function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { state, bom, totals, handleApprove } = useJourney();
  const cfg = useStorefrontConfig();
  const isCart = (cfg as any).commerceMode === 'cart';
  const ordering = !!state.ordering;
  const label = isCart ? 'Cart' : 'Quote';

  const symbol = state.serverQuote?.symbol || '$';
  const currencyCode = state.serverQuote?.currency;
  const money = (n: number | null | undefined): string => {
    if (n === null || n === undefined || Number.isNaN(n)) return 'Price on request';
    return symbol + Math.round(n).toLocaleString('en-US') + (currencyCode ? ` ${currencyCode}` : '');
  };
  const itemCount = bom.reduce((sum, l) => sum + (l.quantity ?? 1), 0);

  const removeLine = (sku?: string) => {
    if (!sku) return;
    (window as any).__handleBuildQuote?.(`Remove SKU ${sku} from my ${isCart ? 'bag' : 'quote'}.`);
  };

  return (
    <>
      <div className="cart-drawer-scrim" data-open={open} onClick={onClose} />
      <aside className="cart-drawer" data-open={open} aria-label={label} aria-hidden={!open}>
        <div className="cart-drawer__head">
          <h2>{label} · {itemCount} {itemCount === 1 ? 'item' : 'items'}</h2>
          <button type="button" className="cart-drawer__close" onClick={onClose} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="cart-drawer__lines">
          {bom.length === 0 ? (
            <div className="cart-drawer__empty">Nothing here yet — ask for a recommendation and I'll add it as you go.</div>
          ) : (
            bom.map((line, i) => (
              <div key={`${line.key}-${i}`} className="cart-drawer__line">
                <div className="cart-drawer__thumb">
                  {line.imageUrl ? <img src={line.imageUrl} alt={line.name} /> : <span>📦</span>}
                </div>
                <div className="cart-drawer__info">
                  <div className="cart-drawer__name">{line.name}</div>
                  <div className="cart-drawer__meta">{money(line.price)}{(line.quantity ?? 1) > 1 ? ` × ${line.quantity}` : ''}</div>
                  {line.stock?.label && <div className="cart-drawer__stock" style={{ color: line.stock.color }}>{line.stock.label}</div>}
                  {!line.required && (
                    <button type="button" className="cart-drawer__remove" onClick={() => removeLine(line.sku)}>Remove</button>
                  )}
                </div>
              </div>
            ))
          )}
        </div>
        {bom.length > 0 && (
          <div className="cart-drawer__foot">
            <div className="cart-drawer__row"><span>Subtotal</span><span>{money(totals.subtotal)}</span></div>
            {!!totals.discount && (
              <div className="cart-drawer__row" style={{ color: 'var(--success)' }}><span>Discount</span><span>−{money(totals.discount)}</span></div>
            )}
            <div className="cart-drawer__row cart-drawer__row--total"><span>Total</span><span>{money(totals.total)}</span></div>
            <button type="button" className="cart-drawer__cta" onClick={handleApprove} disabled={ordering}>
              {ordering ? 'Starting checkout…' : isCart ? 'Checkout' : 'Approve & pay securely'}
            </button>
          </div>
        )}
      </aside>
    </>
  );
}
