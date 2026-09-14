'use client';

/**
 * Inline card rendering (docs/v3-card-cms-architecture.md).
 *
 * Cards used to render one-at-a-time in a separate "stage" column, with older
 * cards demoted to small history chips. The storefront is now a single
 * ChatGPT/Claude-style thread: every card renders INLINE, in place, as part
 * of the turn that produced it — see ChatPanel.tsx's timeline builder, which
 * interleaves `state.cards` with the message list and renders each one with
 * `<CardTile>`. `useCardActions` (the action → behaviour switch) is unchanged
 * and shared by every `<CardTile>` instance.
 */
import { useCallback, useRef } from 'react';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { resolveTemplate } from '@/lib/cards/resolveTemplate';
import { mapClarifyCard } from '@/lib/cards/mappers';
import type { CardInstance } from '@/lib/types';

/**
 * Action → storefront behaviour (docs/v3-card-cms-architecture.md
 * §"Storefront action → behaviour map").
 *
 * Caught live (2026-09-13): `createRenderer` sets up its action wiring once
 * per mount and the card stays mounted (same `stateKey`) across an entire
 * clarify flow, so a plain `useCallback([state, ...])` closure went stale
 * after the card's FIRST render — every chooseOption call kept checking
 * against the empty `dynamicAnswers` from the moment the card appeared, so
 * "every question answered" never became true no matter how many chips were
 * tapped, even though each individual SET_DYNAMIC_ANSWER dispatch landed
 * correctly. `onAction` is now referentially stable (empty dep array) and
 * reads current state through a ref updated on every render instead.
 */
export function useCardActions() {
  const { state, dispatch, handleApprove } = useJourney();
  const cfg = useStorefrontConfig();
  const stateRef = useRef(state);
  stateRef.current = state;
  // The closing surface's own word — a retail brand has a bag, a trade brand
  // a quote — so the message the agent receives matches its vocabulary. Read
  // through a ref: this callback is deliberately stable (see above) and the
  // config arrives after first render, so a plain closure kept "quote".
  const closingRef = useRef<'bag' | 'quote'>('quote');
  closingRef.current = cfg.commerceMode === 'cart' ? 'bag' : 'quote';

  return useCallback((name: string, params?: Record<string, unknown>) => {
    const state = stateRef.current;
    const closing = closingRef.current;
    const w = typeof window !== 'undefined' ? (window as any) : {};
    switch (name) {
      case 'sendMessage':
        w.__journeySend?.(String(params?.text ?? ''));
        break;
      case 'chooseOption': {
        const questionId = String(params?.questionId ?? '');
        const value = String(params?.value ?? '');
        if (!questionId) break;
        dispatch({ type: 'SET_DYNAMIC_ANSWER', questionId, value });
        // Light the chosen chip and update the "n of m answered" footer on
        // the clarify card itself. Submission is NOT decided here: this
        // handler used to call __handleClarifySubmit synchronously, before
        // the dispatch above had committed, so a one-question card sent
        // "→ Not answered" on the very first tap. ChatPanel now watches the
        // committed answers and sends once every question has one.
        const answers = { ...state.dynamicAnswers, [questionId]: value };
        const card = [...state.cards].reverse().find((c) => c.cardType === 'clarify');
        if (card) dispatch({ type: 'PATCH_CARD', id: card.id, state: mapClarifyCard(state.dynamicQuestions, answers) });
        break;
      }
      case 'viewProduct': {
        const sku = String(params?.sku ?? '');
        const p = state.recommendedProducts.find((r) => r.sku === sku);
        if (p) {
          const count = typeof window !== 'undefined' ? (window as any).__journeyMessageCount : undefined;
          dispatch({
            type: 'PUSH_CARD',
            card: {
              id: `productDetail-${sku}-${Date.now()}`,
              cardType: 'productDetail',
              state: { product: { sku, title: p.name, description: p.description, imageUrl: p.imageUrl || null, price: p.price ?? null, category: p.category, specs: p.specs }, closing },
              createdAt: String(count ?? 0),
            },
          });
        }
        break;
      }
      case 'addToCart':
        w.__handleBuildQuote?.(params?.sku ? `Add SKU ${params.sku} (qty ${params?.qty ?? 1}) to my ${closing}.` : undefined);
        break;
      case 'addAllToCart':
        w.__handleBuildQuote?.();
        break;
      case 'setQuantity':
        // Server-authoritative quote — a quantity change is a new build-quote
        // request, not a client-side edit; the agent recomputes price/stock.
        w.__handleBuildQuote?.(`Change the quantity of SKU ${params?.sku} to ${params?.qty}.`);
        break;
      case 'removeFromCart':
        w.__handleBuildQuote?.(`Remove SKU ${params?.sku} from my ${closing}.`);
        break;
      case 'selectBranch': {
        const branchId = String(params?.branchId ?? '');
        if (!branchId) break;
        (async () => {
          try {
            const res = await fetch('/api/branch-stock' + window.location.search, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ branch: branchId, skus: state.serverQuote?.lines.map((l) => l.sku) || [] }),
            });
            const data = await res.json();
            if (data?.ok) {
              const bySku: Record<string, any> = {};
              for (const r of data.results || []) bySku[r.sku] = r;
              dispatch({ type: 'APPLY_QUOTE_BRANCH_STOCK', branch: branchId, branchName: data.branchName || branchId, bySku });
            }
          } catch { /* silent — branch check is best-effort */ }
        })();
        break;
      }
      case 'checkout':
        handleApprove();
        break;
      case 'openPanel':
        if (params?.panel) dispatch({ type: 'SET_PHASE', phase: params.panel as any });
        break;
      case 'openUrl':
        if (params?.url) window.open(String(params.url), '_blank', 'noopener');
        break;
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, handleApprove]);
}

/** One card, rendered inline at its place in the conversation thread. */
export function CardTile({ card, onAction }: { card: CardInstance; onAction: (name: string, params?: Record<string, unknown>) => void }) {
  const cfg = useStorefrontConfig();
  return (
    <div className="jx-root chat-inline-card" data-card-type={card.cardType}>
      <CardRenderer
        template={resolveTemplate(cfg, card.cardType)}
        state={card.state}
        settings={cfg.uiTheme?.cards?.[card.cardType]?.options}
        onAction={onAction}
        stateKey={card.id}
      />
    </div>
  );
}
