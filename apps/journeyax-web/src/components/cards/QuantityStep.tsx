'use client';

/**
 * Asks how many before anything is added: a stepper with a typed number, "Add N", and a way to have the consultant work the
 * number out from the customer's area. The words are the storefront's own (config labels, with neutral defaults).
 */
import { useEffect, useId, useRef, useState } from 'react';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { MAX_QUANTITY, clampQuantity, closeQuantityStep, useQuantityRequest } from '@/lib/cards/quantityStep';

const DEFAULT_LABELS = {
  title: 'How many do you need?',
  more: 'One more',
  fewer: 'One fewer',
  field: 'Quantity',
  add: 'Add',
  workItOut: 'Work it out from my area',
  cancel: 'Not now',
};

export default function QuantityStepHost() {
  const request = useQuantityRequest();
  if (!request) return null;
  // Keyed by the request so a new tap starts from its own number.
  return <QuantityDialog key={`${request.sku}:${request.initial}`} />;
}

function QuantityDialog() {
  const request = useQuantityRequest()!;
  const cfg = useStorefrontConfig() as any;
  const labels = { ...DEFAULT_LABELS, ...(cfg?.labels?.quantityStep || {}) };
  const [quantity, setQuantity] = useState(request.initial);
  const [typed, setTyped] = useState(String(request.initial));
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') closeQuantityStep(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const set = (next: number) => { const n = clampQuantity(next, quantity); setQuantity(n); setTyped(String(n)); };
  const confirm = () => { const n = clampQuantity(typed, quantity); closeQuantityStep(); request.onConfirm(n); };
  const workItOut = () => { closeQuantityStep(); request.onWorkItOut(); };

  return (
    <div className="qty-step" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeQuantityStep(); }}>
      <form className="qty-step__panel" role="dialog" aria-modal="true" aria-labelledby={titleId} onSubmit={(event) => { event.preventDefault(); confirm(); }}>
        <div className="qty-step__item">
          {request.imageUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img className="qty-step__img" src={request.imageUrl} alt="" />
          ) : null}
          <div className="qty-step__name">{request.title}</div>
        </div>
        <div id={titleId} className="qty-step__title">{labels.title}</div>
        <div className="qty-step__stepper">
          <button type="button" className="qty-step__btn" aria-label={labels.fewer} onClick={() => set(quantity - 1)} disabled={quantity <= 1}>−</button>
          <input
            ref={inputRef}
            className="qty-step__input"
            inputMode="numeric"
            aria-label={labels.field}
            value={typed}
            maxLength={String(MAX_QUANTITY).length}
            onChange={(event) => { const digits = event.target.value.replace(/\D/g, ''); setTyped(digits); const n = Math.floor(Number(digits)); if (n >= 1) setQuantity(Math.min(MAX_QUANTITY, n)); }}
            onBlur={() => set(clampQuantity(typed, quantity))}
          />
          <button type="button" className="qty-step__btn" aria-label={labels.more} onClick={() => set(quantity + 1)} disabled={quantity >= MAX_QUANTITY}>+</button>
        </div>
        <div className="qty-step__actions">
          <button type="submit" className="qty-step__primary">{labels.add} {clampQuantity(typed, quantity)}</button>
          <button type="button" className="qty-step__link" onClick={workItOut}>{labels.workItOut}</button>
          <button type="button" className="qty-step__link qty-step__link--quiet" onClick={closeQuantityStep}>{labels.cancel}</button>
        </div>
      </form>
    </div>
  );
}
