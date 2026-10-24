'use client';

/**
 * Paying inside the side panel. The card form is Stripe's own embedded form (it opens in this panel, so the customer never leaves
 * the page and no card data touches us). When the payment completes, the order is read back from the server until it says paid, then
 * recorded in the journey (which tells the consultant) and the order opens in the panel.
 */
import { useEffect, useRef, useState } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { openCanvas } from '@/lib/shell/sidePanelStore';
import { formatMoney, orderRef } from './money';

declare global { interface Window { Stripe?: (key: string) => any } }

let stripeScript: Promise<void> | null = null;
function loadStripeJs(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Stripe) return Promise.resolve();
  if (!stripeScript) {
    stripeScript = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => { stripeScript = null; reject(new Error('The payment form could not be loaded.')); };
      document.head.appendChild(script);
    });
  }
  return stripeScript;
}

type Phase = 'loading' | 'ready' | 'confirming' | 'error';

export default function CheckoutCanvas({ orderId, payment }: { orderId: string; payment: { clientSecret: string; publishableKey: string } }) {
  const { state, dispatch, bom, totals } = useJourney();
  const mount = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [message, setMessage] = useState('');
  const symbol = state.serverQuote?.symbol;
  const currency = state.serverQuote?.currency;
  const money = (amount: number | null | undefined) => formatMoney(amount, symbol, currency);

  useEffect(() => {
    let destroyed = false;
    let checkout: { destroy?: () => void; mount: (el: HTMLElement) => void } | null = null;

    const confirm = async () => {
      setPhase('confirming');
      for (let attempt = 0; attempt < 20 && !destroyed; attempt++) {
        try {
          const res = await fetch(`/api/order?orderId=${encodeURIComponent(orderId)}&${window.location.search.slice(1)}`, { cache: 'no-store' });
          const data = await res.json();
          if (data?.found && data.status === 'paid') {
            // The journey now knows the order is paid (it tells the consultant and shows the order card); the order opens here.
            dispatch({ type: 'SET_PLACED_ORDER', order: data });
            openCanvas({ kind: 'order', orderId });
            return;
          }
        } catch { /* try again */ }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      if (!destroyed) { setPhase('error'); setMessage('Your payment is taking longer than usual to confirm. Please do not pay twice: ask us about this order and we will check it.'); }
    };

    (async () => {
      try {
        await loadStripeJs();
        if (destroyed || !mount.current) return;
        const stripe = window.Stripe!(payment.publishableKey);
        checkout = await stripe.initEmbeddedCheckout({ clientSecret: payment.clientSecret, onComplete: () => { void confirm(); } });
        if (destroyed || !mount.current) { checkout?.destroy?.(); return; }
        checkout!.mount(mount.current);
        setPhase('ready');
      } catch (error: any) {
        if (!destroyed) { setPhase('error'); setMessage(String(error?.message || 'The payment form could not be opened.')); }
      }
    })();

    return () => { destroyed = true; try { checkout?.destroy?.(); } catch { /* already gone */ } };
  }, [orderId, payment.clientSecret, payment.publishableKey, dispatch]);

  return (
    <div className="cv">
      <div className="cv__body">
        <div className="cv__order-head">
          <div>
            <div className="cv__eyebrow">Paying for order</div>
            <div className="cv__order-no">#{orderRef(orderId)}</div>
          </div>
          <div className="cv__order-total">{money(totals.total)}</div>
        </div>
        <ul className="cv__mini">
          {bom.map((line, index) => <li key={`${line.key}-${index}`}><span>{line.quantity ?? 1} × {line.name}</span></li>)}
        </ul>
        {phase === 'loading' && <p className="cv__meta">Opening the secure payment form…</p>}
        {phase === 'confirming' && <p className="cv__notice" role="status">Payment received. Confirming your order…</p>}
        {phase === 'error' && <div role="alert" className="cv__alert">{message}</div>}
        <div ref={mount} className="cv__pay" hidden={phase === 'error' || phase === 'confirming'} />
        <p className="cv__meta cv__secure">Card details go straight to Stripe. We never see or store them.</p>
      </div>
    </div>
  );
}
