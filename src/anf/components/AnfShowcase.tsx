'use client';

import { useState } from 'react';
import { useAnf } from '../AnfContext';
import { recommend, curationHeadline } from '../stylist';
import { Product, formatUSD } from '../types';
import GarmentIcon from './GarmentIcon';

export default function AnfShowcase() {
  const { state } = useAnf();
  return (
    <div className="anf-showcase">
      {state.phase === 'intro' && <HeroPanel />}
      {state.phase === 'style' && <StyleQuizPanel />}
      {state.phase === 'curating' && <CuratingPanel />}
      {state.phase === 'products' && <ProductsPanel />}
      {state.phase === 'bag' && <BagPanel />}
      {state.phase === 'confirmed' && <ConfirmedPanel />}
    </div>
  );
}

// ─── Hero ────────────────────────────────────────────────────────────────
function HeroPanel() {
  return (
    <div className="anf-hero">
      <div className="anf-hero__eyebrow">A&amp;F · MADE TO BE SEEN</div>
      <h1 className="anf-hero__title">
        Your wardrobe, styled in one conversation.
      </h1>
      <p className="anf-hero__lede">
        Tell the stylist the occasion, your fit, and your palette. I&apos;ll pull a
        personalized edit from the A&amp;F collection, build a full look, and check
        you out — member perks applied automatically.
      </p>
      <div className="anf-pills">
        <span className="anf-pill">Personalized edit</span>
        <span className="anf-pill">Full-look styling</span>
        <span className="anf-pill">Free shipping over $75</span>
      </div>
      <div className="anf-hero__cue">Start on the left — tell me your occasion →</div>
    </div>
  );
}

// ─── Style quiz ───────────────────────────────────────────────────────────
function StyleQuizPanel() {
  const { state, dispatch, quizComplete } = useAnf();

  const submit = () => {
    if (!quizComplete) return;
    dispatch({ type: 'SET_PHASE', phase: 'curating' });
    dispatch({ type: 'SET_THINKING', thinking: true });

    window.setTimeout(() => {
      const products = recommend(state.quizAnswers);
      const headline = curationHeadline(state.quizAnswers);
      dispatch({ type: 'SET_RECOMMENDED', products, heroReason: headline });
      dispatch({ type: 'SET_PHASE', phase: 'products' });
      dispatch({
        type: 'ADD_MESSAGE',
        role: 'ai',
        text: `Here's your edit — ${products.length} pieces I pulled just for you, on the right. Tap the colors and sizes you like, add them to your bag, and I'll total it up with your member discount.`,
      });
      dispatch({ type: 'SET_THINKING', thinking: false });
    }, 1100);
  };

  return (
    <div className="anf-quiz">
      <div className="anf-panel-head">
        <div className="anf-panel-head__eyebrow">STYLE PROFILE</div>
        <h2 className="anf-panel-head__title">A few quick questions</h2>
        <p className="anf-panel-head__sub">
          So I only show you pieces that actually fit the brief.
        </p>
      </div>

      <div className="anf-quiz__list">
        {state.quizQuestions.map((q) => (
          <div key={q.id} className="anf-quiz__q">
            <div className="anf-quiz__title">{q.title}</div>
            <div className="anf-quiz__options">
              {q.options.map((opt) => {
                const active = state.quizAnswers[q.id] === opt;
                return (
                  <button
                    key={opt}
                    className={`anf-opt ${active ? 'anf-opt--on' : ''}`}
                    onClick={() =>
                      dispatch({ type: 'SET_QUIZ_ANSWER', id: q.id, value: opt })
                    }
                  >
                    {opt}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <button
        className="anf-cta"
        disabled={!quizComplete}
        onClick={submit}
      >
        {quizComplete ? 'See my edit' : 'Answer all to continue'}
      </button>
    </div>
  );
}

// ─── Curating ─────────────────────────────────────────────────────────────
function CuratingPanel() {
  return (
    <div className="anf-curating">
      <div className="anf-curating__spinner" />
      <div className="anf-curating__text">Styling your edit…</div>
      <div className="anf-curating__sub">Matching fits, palette and occasion</div>
    </div>
  );
}

// ─── Products ─────────────────────────────────────────────────────────────
function ProductsPanel() {
  const { state, dispatch, totals } = useAnf();
  return (
    <div className="anf-products">
      <div className="anf-panel-head">
        <div className="anf-panel-head__eyebrow">YOUR EDIT</div>
        <h2 className="anf-panel-head__title">{state.heroReason}</h2>
        <p className="anf-panel-head__sub">
          {state.recommended.length} pieces · tap a color and size, then add to bag
        </p>
      </div>

      <div className="anf-grid">
        {state.recommended.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>

      <div className="anf-bag-bar">
        <div className="anf-bag-bar__info">
          {totals.itemCount > 0
            ? `${totals.itemCount} item${totals.itemCount > 1 ? 's' : ''} · ${formatUSD(totals.subtotal)}`
            : 'Your bag is empty'}
        </div>
        <button
          className="anf-cta anf-cta--sm"
          disabled={totals.itemCount === 0}
          onClick={() => dispatch({ type: 'SET_PHASE', phase: 'bag' })}
        >
          View bag
        </button>
      </div>
    </div>
  );
}

function ProductCard({ product }: { product: Product }) {
  const { dispatch } = useAnf();
  const [color, setColor] = useState(product.colors[0]);
  const [size, setSize] = useState(
    product.sizes[Math.floor(product.sizes.length / 2)]
  );

  const add = () => {
    dispatch({
      type: 'ADD_TO_BAG',
      item: {
        productId: product.id,
        name: product.name,
        price: product.price,
        size,
        color: color.name,
        category: product.category,
      },
    });
    dispatch({
      type: 'ADD_MESSAGE',
      role: 'note',
      head: 'Added to bag',
      text: `${product.name} · ${size} / ${color.name}`,
    });
  };

  return (
    <div className="anf-card">
      <div className="anf-card__img" style={{ background: color.hex }}>
        <div className="anf-card__icon">
          <GarmentIcon category={product.category} color={color.hex} />
        </div>
        <span className="anf-card__cat">{product.category}</span>
      </div>
      <div className="anf-card__body">
        <div className="anf-card__row">
          <div className="anf-card__name">{product.name}</div>
          <div className="anf-card__price">{formatUSD(product.price)}</div>
        </div>
        <div className="anf-card__reason">{product.reason}</div>

        <div className="anf-card__label">Color · {color.name}</div>
        <div className="anf-swatches">
          {product.colors.map((c) => (
            <button
              key={c.name}
              title={c.name}
              className={`anf-swatch ${color.name === c.name ? 'anf-swatch--on' : ''}`}
              style={{ background: c.hex }}
              onClick={() => setColor(c)}
            />
          ))}
        </div>

        <div className="anf-card__label">Size</div>
        <div className="anf-sizes">
          {product.sizes.map((s) => (
            <button
              key={s}
              className={`anf-size ${size === s ? 'anf-size--on' : ''}`}
              onClick={() => setSize(s)}
            >
              {s}
            </button>
          ))}
        </div>

        <button className="anf-add" onClick={add}>
          Add to bag
        </button>
      </div>
    </div>
  );
}

// ─── Bag ──────────────────────────────────────────────────────────────────
function BagPanel() {
  const { state, dispatch, totals, placeOrder } = useAnf();

  if (state.bag.length === 0) {
    return (
      <div className="anf-bag anf-bag--empty">
        <h2 className="anf-panel-head__title">Your bag is empty</h2>
        <button
          className="anf-cta"
          onClick={() =>
            dispatch({
              type: 'SET_PHASE',
              phase: state.recommended.length ? 'products' : 'intro',
            })
          }
        >
          {state.recommended.length ? 'Back to my edit' : 'Start styling'}
        </button>
      </div>
    );
  }

  return (
    <div className="anf-bag">
      <div className="anf-panel-head">
        <div className="anf-panel-head__eyebrow">SHOPPING BAG</div>
        <h2 className="anf-panel-head__title">Review your look</h2>
      </div>

      <div className="anf-bag__list">
        {state.bag.map((item) => (
          <div key={item.key} className="anf-bag__item">
            <div className="anf-bag__meta">
              <div className="anf-bag__name">{item.name}</div>
              <div className="anf-bag__variant">
                {item.category} · {item.color} · {item.size}
              </div>
            </div>
            <div className="anf-qty">
              <button onClick={() => dispatch({ type: 'CHANGE_QTY', key: item.key, delta: -1 })}>
                −
              </button>
              <span>{item.qty}</span>
              <button onClick={() => dispatch({ type: 'CHANGE_QTY', key: item.key, delta: 1 })}>
                +
              </button>
            </div>
            <div className="anf-bag__price">{formatUSD(item.price * item.qty)}</div>
            <button
              className="anf-bag__remove"
              aria-label="Remove"
              onClick={() => dispatch({ type: 'REMOVE_FROM_BAG', key: item.key })}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      <div className="anf-summary">
        <div className="anf-summary__row">
          <span>Subtotal</span>
          <span>{formatUSD(totals.subtotal)}</span>
        </div>
        <div className="anf-summary__row anf-summary__row--save">
          <span>A&amp;F member (15% off)</span>
          <span>−{formatUSD(totals.discount)}</span>
        </div>
        <div className="anf-summary__row">
          <span>Shipping</span>
          <span>{totals.shipping === 0 ? 'Free' : formatUSD(totals.shipping)}</span>
        </div>
        <div className="anf-summary__row anf-summary__row--total">
          <span>Total</span>
          <span>{formatUSD(totals.total)}</span>
        </div>
      </div>

      <div className="anf-bag__actions">
        <button
          className="anf-ghost"
          onClick={() =>
            dispatch({
              type: 'SET_PHASE',
              phase: state.recommended.length ? 'products' : 'intro',
            })
          }
        >
          Keep shopping
        </button>
        <button className="anf-cta anf-cta--grow" onClick={placeOrder}>
          Place order · {formatUSD(totals.total)}
        </button>
      </div>
    </div>
  );
}

// ─── Confirmed ─────────────────────────────────────────────────────────────
function ConfirmedPanel() {
  const { state, dispatch, totals } = useAnf();
  return (
    <div className="anf-confirmed">
      <div className="anf-confirmed__check">
        <svg width="34" height="34" viewBox="0 0 24 24" fill="none">
          <path
            d="M5 13l4 4L19 7"
            stroke="#F6F2EA"
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </div>
      <h2 className="anf-confirmed__title">Order confirmed</h2>
      <div className="anf-confirmed__id">{state.orderId}</div>
      <p className="anf-confirmed__sub">
        {totals.itemCount} item{totals.itemCount > 1 ? 's' : ''} · {formatUSD(totals.total)} · arriving in 3–5 days
      </p>

      <div className="anf-confirmed__list">
        {state.bag.map((item) => (
          <div key={item.key} className="anf-confirmed__line">
            <span>
              {item.qty}× {item.name} ({item.color} / {item.size})
            </span>
            <span>{formatUSD(item.price * item.qty)}</span>
          </div>
        ))}
      </div>

      <button className="anf-cta" onClick={() => dispatch({ type: 'RESET' })}>
        Style another look
      </button>
    </div>
  );
}
