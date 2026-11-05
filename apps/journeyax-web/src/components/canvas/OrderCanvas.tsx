'use client';

/**
 * A placed order: what was bought, who it is billed to, where it goes, and the summary. Everything is read from the order itself
 * (the server's record), so it is the same whether the customer has just paid or comes back to it later.
 */
import { useEffect, useState } from 'react';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { formatMoney, orderRef } from './money';

interface Party { name?: string; email?: string; phone?: string; address?: { line1?: string; line2?: string; city?: string; state?: string; postalCode?: string; country?: string } }
interface OrderView {
  found: boolean; orderId?: string; status?: string; total?: number; currency?: string; symbol?: string; title?: string; paidAt?: string | null; createdAt?: string | null;
  subtotal?: number; discount?: number; tax?: number; taxRate?: number; leadTimeSummary?: string;
  lines?: Array<{ sku: string; name?: string; quantity?: number; unitPrice?: number | null; lineTotal?: number; imageUrl?: string }>;
  billing?: Party | null; shipping?: Party | null;
}

const addressLines = (party: Party | null | undefined): string[] => {
  const a = party?.address;
  if (!a) return [];
  return [a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter((part): part is string => !!part && part.trim().length > 0);
};

const when = (iso?: string | null) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

export default function OrderCanvas({ orderId }: { orderId: string }) {
  const [order, setOrder] = useState<OrderView | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setOrder(null);
    setFailed(false);
    fetch(`/api/order?orderId=${encodeURIComponent(orderId)}&${typeof window !== 'undefined' ? window.location.search.slice(1) : ''}`, { cache: 'no-store' })
      .then((res) => res.json())
      .then((data: OrderView) => { if (!cancelled) { if (data?.found) setOrder(data); else setFailed(true); } })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [orderId]);

  if (failed) return <div className="cv"><div className="cv__body"><p className="cv__empty-title">Order details are unavailable</p><p className="cv__empty-text">Please check the order number or try again. A failed lookup does not confirm the payment status.</p></div></div>;
  if (!order) return <div className="cv"><div className="cv__body"><p className="cv__empty-text">Getting your order…</p></div></div>;

  const money = (amount: number | null | undefined) => formatMoney(amount, order.symbol, order.currency);
  const paid = order.status === 'paid';
  const ended = order.status === 'failed' || order.status === 'cancelled';
  const billingLines = addressLines(order.billing);
  const shippingLines = addressLines(order.shipping);

  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Order</div>
            <div className="cv__order-no">#{orderRef(order.orderId)}</div>
            {when(order.paidAt || order.createdAt) && <div className="cv__meta">{paid ? 'Paid' : 'Started'} {when(order.paidAt || order.createdAt)}</div>}
          </div>
          <span className={`cv__chip ${paid ? 'cv__chip--ok' : 'cv__chip--wait'}`}>{paid ? 'Paid' : order.status === 'pending_payment' ? 'Waiting for payment' : order.status === 'failed' ? 'Payment not completed' : order.status === 'cancelled' ? 'Payment cancelled' : order.status}</span>
        </div>
        {ended && <div role="status" className="cv__notice">This payment session has ended. The items below are the saved order record. Review your cart and refresh the quote before starting another checkout.<button type="button" className="cv__link" onClick={() => openCanvas({ kind: 'cart' })}>View current cart</button></div>}

        <h3 className="cv__h">Items</h3>
        <ul className="cv__lines">
          {(order.lines || []).map((line) => (
            <li key={line.sku} className="cv__line">
              <div className="cv__thumb">{line.imageUrl ? <img src={line.imageUrl} alt="" /> : <span aria-hidden="true">□</span>}</div>
              <div className="cv__info">
                <div className="cv__name">{line.name || line.sku}</div>
                <div className="cv__meta">SKU {line.sku} · {line.quantity ?? 1} × {money(line.unitPrice)}</div>
              </div>
              <div className="cv__total">{money(line.lineTotal)}</div>
            </li>
          ))}
        </ul>

        <div className="cv__cols">
          <section>
            <h3 className="cv__h">Billing</h3>
            {order.billing ? (
              <address className="cv__addr">
                {order.billing.name && <strong>{order.billing.name}</strong>}
                {billingLines.map((part, i) => <span key={i}>{part}</span>)}
                {order.billing.email && <span>{order.billing.email}</span>}
                {order.billing.phone && <span>{order.billing.phone}</span>}
              </address>
            ) : <p className="cv__meta">Billing details are added when the payment is confirmed.</p>}
          </section>
          <section>
            <h3 className="cv__h">Shipping</h3>
            {order.shipping ? (
              <address className="cv__addr">
                {order.shipping.name && <strong>{order.shipping.name}</strong>}
                {shippingLines.map((part, i) => <span key={i}>{part}</span>)}
              </address>
            ) : <p className="cv__meta">No delivery address is recorded on this order. Delivery or collection arrangements are not confirmed here.</p>}
          </section>
        </div>

        <h3 className="cv__h">Summary</h3>
        <div className="cv__summary">
          {order.subtotal != null && <div className="cv__sum"><span>Subtotal</span><span>{money(order.subtotal)}</span></div>}
          {!!order.discount && <div className="cv__sum cv__sum--good"><span>Discount</span><span>−{money(order.discount)}</span></div>}
          {!!order.tax && <div className="cv__sum"><span>{order.taxRate != null ? `${Math.round(order.taxRate * 100)}% tax` : 'Tax'}</span><span>{money(order.tax)}</span></div>}
          <div className="cv__sum cv__sum--grand"><span>{paid ? 'Total paid' : 'Total'}</span><span>{money(order.total)}</span></div>
        </div>
        {order.leadTimeSummary && <p className="cv__meta">{order.leadTimeSummary}</p>}
      </div>
    </div>
  );
}
