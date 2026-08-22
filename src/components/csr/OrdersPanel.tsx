'use client';

import { useEffect, useState } from 'react';

interface OrderLine {
  key: string; sku?: string; name: string; price: number; quantity: number; category?: string;
}
interface OrderRecord {
  id: string; source: 'caroma' | 'shop'; title: string; jobId?: string;
  lines: OrderLine[]; subtotal: number; discount: number; gst: number; total: number;
  createdAt: string; status: 'new' | 'in-review' | 'processed';
  handledBy?: string; handledAt?: string;
}

function money(n: number): string {
  return '$' + n.toLocaleString('en-AU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function timeAgo(iso: string): string {
  const min = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/**
 * The staff view of completed checkouts from both journeys (`/` Caroma and
 * `/shop` apparel — one shared checkout path, see JourneyContext.tsx's
 * handleApprove). Before /api/orders/submit existed, nothing survived past
 * the shopper's own browser tab; this is the first place anyone else can
 * see what was actually ordered.
 */
export default function OrdersPanel() {
  const [orders, setOrders] = useState<OrderRecord[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const res = await fetch('/api/orders', { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) { setError(body?.error?.message ?? 'Could not load orders.'); return; }
      setOrders(body.orders ?? []);
    } catch {
      setError('Could not reach the server.');
    }
  };

  // The rule cannot tell a synchronous setState cascade from an ordinary
  // fetch-on-mount — every state update inside load() happens after an
  // await, which is the pattern the rule exists to catch, not this one.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load(); }, []);

  const selected = orders?.find(o => o.id === selectedId) ?? null;

  async function setStatus(id: string, status: OrderRecord['status']) {
    setBusy(true);
    try {
      const res = await fetch(`/api/orders/${encodeURIComponent(id)}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      if (res.ok) await load();
    } finally {
      setBusy(false);
    }
  }

  if (error) return <div className="csr-ho-empty">{error}</div>;
  if (!orders) return <div className="csr-ho-empty">Loading…</div>;

  if (selected) {
    return (
      <div className="csr-ho-detail">
        <button className="csr-ho-back" onClick={() => setSelectedId(null)}>&larr; All orders</button>

        <div className="csr-ho-detail__head">
          <div>
            <p className="csr-ho-detail__ref">{selected.id} · {selected.source === 'shop' ? 'Apparel' : 'Bathroom'}</p>
            <h2 className="csr-ho-detail__title">{selected.title}</h2>
          </div>
          <span className={`csr-pill csr-pill--${selected.status === 'processed' ? 'good' : selected.status === 'in-review' ? 'warn' : 'mock'}`}>
            {selected.status.replace('-', ' ').toUpperCase()}
          </span>
        </div>

        <section className="csr-ho-step">
          <h3 className="csr-ho-step__title">Lines ({selected.lines.length})</h3>
          <div className="csr-ho-roster">
            {selected.lines.map(l => (
              <div key={l.key} className="csr-ho-roster__row">
                <span className="csr-ho-roster__name">{l.name}{l.sku ? ` (${l.sku})` : ''}</span>
                <span className="csr-ho-roster__size">×{l.quantity}</span>
                <span className="csr-ho-roster__size">{money(l.price * l.quantity)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="csr-ho-step">
          <h3 className="csr-ho-step__title">Total</h3>
          <dl className="csr-ho-facts">
            <div><dt>Subtotal</dt><dd>{money(selected.subtotal)}</dd></div>
            <div><dt>Discount</dt><dd>-{money(selected.discount)}</dd></div>
            <div><dt>GST</dt><dd>{money(selected.gst)}</dd></div>
            <div><dt>Total</dt><dd>{money(selected.total)}</dd></div>
            <div><dt>Placed</dt><dd>{timeAgo(selected.createdAt)}</dd></div>
          </dl>
        </section>

        <section className="csr-ho-step">
          {selected.handledBy && (
            <p className="csr-ho-note">
              Last touched by {selected.handledBy} — {selected.handledAt ? timeAgo(selected.handledAt) : ''}
            </p>
          )}
          <div className="csr-ho-actions">
            {selected.status !== 'in-review' && (
              <button className="csr-btn" disabled={busy} onClick={() => setStatus(selected.id, 'in-review')}>
                Mark in review
              </button>
            )}
            {selected.status !== 'processed' && (
              <button className="csr-btn csr-btn--primary" disabled={busy} onClick={() => setStatus(selected.id, 'processed')}>
                Mark processed
              </button>
            )}
          </div>
        </section>
      </div>
    );
  }

  if (orders.length === 0) {
    return <div className="csr-ho-empty">No orders yet. They will appear here the moment a customer checks out on / or /shop.</div>;
  }

  return (
    <div className="csr-ho-list">
      {orders.map(o => (
        <button key={o.id} className="csr-ho-item" onClick={() => setSelectedId(o.id)}>
          <div className="csr-ho-item__main">
            <span className="csr-ho-item__ref">{o.id}</span>
            <span className="csr-ho-item__team">{o.title}</span>
            <span className="csr-ho-item__meta">
              {o.source === 'shop' ? 'Apparel' : 'Bathroom'} · {money(o.total)} · {timeAgo(o.createdAt)}
            </span>
          </div>
          <span className={`csr-pill csr-pill--${o.status === 'processed' ? 'good' : o.status === 'in-review' ? 'warn' : 'mock'}`}>
            {o.status.replace('-', ' ').toUpperCase()}
          </span>
        </button>
      ))}
    </div>
  );
}
