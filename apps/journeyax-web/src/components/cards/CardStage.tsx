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
import { mapClarifyCard, usableImage } from '@/lib/cards/mappers';
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
/** First configured hand-off (config `handoffs`) whose match fits this product, or undefined. */
function matchHandoff(
  handoffs: { match: { category?: string; titleContains?: string; skuPrefix?: string }; label: string; url: string; note?: string }[] | undefined,
  p: { sku: string; name?: string; category?: string },
): { label: string; url: string; note?: string } | undefined {
  const name = (p.name || '').toLowerCase();
  for (const h of handoffs || []) {
    const m = h.match || {};
    if (m.category && m.category.toLowerCase() !== (p.category || '').toLowerCase()) continue;
    if (m.titleContains && !name.includes(m.titleContains.toLowerCase())) continue;
    if (m.skuPrefix && !p.sku.toUpperCase().startsWith(m.skuPrefix.toUpperCase())) continue;
    if (!m.category && !m.titleContains && !m.skuPrefix) continue;
    return { label: h.label, url: h.url, note: h.note };
  }
  return undefined;
}

/** The product a card is showing under this SKU (products / bundle / comparison / accessories), shaped like a RecommendedProduct. */
function findCardProduct(cards: CardInstance[], sku: string): { sku: string; name: string; description?: string; imageUrl?: string | null; price?: number | null; category?: string; specs?: Record<string, string | number> } | undefined {
  for (const c of [...cards].reverse()) {
    const st: any = c.state || {};
    const pools: any[] = [st.products, st.items, ...(Array.isArray(st.groups) ? st.groups.map((g: any) => g?.items) : [])];
    for (const pool of pools) {
      const hit = Array.isArray(pool) ? pool.find((p: any) => String(p?.sku || '') === sku) : null;
      if (hit) return { sku, name: hit.title || hit.name || sku, description: hit.description || hit.reason, imageUrl: hit.imageUrl ?? null, price: hit.price ?? null, category: hit.category, specs: hit.specs };
    }
  }
  return undefined;
}

export function useCardActions() {
  const { state, dispatch, handleApprove, addToCart, removeFromCart, setQuantity, setCartOpen } = useJourney();
  const cfg = useStorefrontConfig();
  const stateRef = useRef(state);
  stateRef.current = state;
  // The closing surface's own word — a retail brand has a bag, a trade brand
  // a quote — so the message the agent receives matches its vocabulary. Read
  // through a ref: this callback is deliberately stable (see above) and the
  // config arrives after first render, so a plain closure kept "quote".
  const closingRef = useRef<'bag' | 'quote'>('quote');
  closingRef.current = cfg.commerceMode === 'cart' ? 'bag' : 'quote';
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

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

        const cardId = params?.cardId ? String(params.cardId) : undefined;
        const card = cardId
          ? state.cards.find((c) => c.id === cardId)
          : [...state.cards].reverse().find((c) => c.cardType === 'clarify');

        if (card) {
          const currentQuestions: any[] =
            Array.isArray((card.state as any)?.questions) && (card.state as any).questions.length > 0
              ? (card.state as any).questions
              : state.dynamicQuestions.map((q) => ({ id: q.id, text: q.title, options: q.options }));

          const answers = { ...state.dynamicAnswers, [questionId]: value };

          const updatedQuestions = currentQuestions.map((q: any) => ({
            ...q,
            answer: answers[q.id] !== undefined ? answers[q.id] : q.answer,
          }));

          const total = updatedQuestions.length;
          const answeredCount = updatedQuestions.filter((q: any) => {
            const ans = answers[q.id] !== undefined ? answers[q.id] : q.answer;
            return ans !== undefined && ans !== null && ans !== '';
          }).length;
          const left = total - answeredCount;

          const progress = total === 0
            ? undefined
            : left === 0
              ? `All ${total === 1 ? 'set' : `${total} answered`} — sending your answers…`
              : total === 1
                ? 'Pick one to continue.'
                : `${answeredCount} of ${total} answered — pick the ${left === 1 ? 'last one' : 'rest'} whenever you're ready, nothing sends until then.`;

          dispatch({
            type: 'PATCH_CARD',
            id: card.id,
            state: {
              ...card.state,
              questions: updatedQuestions,
              progress,
            },
          });

          // ChatPanel's useEffect monitors dynamicAnswers and will submit with fingerprint deduplication once all questions are answered
          if (!w.__handleClarifySubmit && (left === 0 || total <= 1)) {
            // Only if ChatPanel bridge is somehow absent, fallback to direct send
            const answerSummary = updatedQuestions
              .map((q: any) => `${q.text || q.title || q.id} → ${answers[q.id] ?? q.answer ?? 'Not answered'}`)
              .join('\n');
            const clarificationText = `My answers:\n${answerSummary}`;
            w.__journeySend?.(clarificationText);
          }
        } else {
          // If no clarify card was mapped, forward the selected value directly
          w.__journeySend?.(value);
        }
        break;
      }
      case 'selectItem': {
        const sku = String(params?.sku ?? '').trim();
        const title = String(params?.title || params?.name || params?.label || '').trim();
        const value = String(params?.value ?? params?.id ?? params?.key ?? '').trim();
        const questionId = String(params?.questionId ?? '').trim();

        if (questionId && (value || title)) {
          dispatch({ type: 'SET_DYNAMIC_ANSWER', questionId, value: value || title });
        }

        if (sku) {
          const text = title ? `I choose ${title} (SKU ${sku})` : `I choose SKU ${sku}`;
          w.__journeySend?.(text);
        } else if (title || value) {
          w.__journeySend?.(`I choose ${title || value}`);
        } else if (params?.text) {
          w.__journeySend?.(String(params.text));
        }
        break;
      }
      case 'selectTheme':
      case 'selectDesign': {
        const label = String(params?.name || params?.title || params?.label || params?.theme || params?.design || params?.value || params?.id || 'this design').trim();
        w.__journeySend?.(`I choose ${label}`);
        break;
      }
      case 'nextStep':
      case 'next':
      case 'proceed':
      case 'continue': {
        const text = String(params?.text || params?.label || params?.step || 'Continue to next step').trim();
        w.__journeySend?.(text);
        break;
      }
      case 'viewProduct': {
        const sku = String(params?.sku ?? '');
        // The tapped tile may belong to a bundle, comparison or accessories
        // card whose items never entered recommendedProducts — fall back to
        // whatever card is showing that SKU, so every tile opens its detail.
        const p = state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku);
        if (p) {
          const count = typeof window !== 'undefined' ? (window as any).__journeyMessageCount : undefined;
          dispatch({
            type: 'PUSH_CARD',
            card: {
              id: `productDetail-${sku}-${Date.now()}`,
              cardType: 'productDetail',
              state: { product: { sku, title: p.name, description: p.description, imageUrl: usableImage(p.imageUrl), price: p.price ?? null, category: p.category, specs: p.specs }, closing, handoff: matchHandoff(cfgRef.current.handoffs, { sku, name: p.name, category: p.category }) },
              createdAt: String(count ?? 0),
            },
          });
        }
        break;
      }
      case 'addToCart': {
        const sku = String(params?.sku ?? '').trim();
        if (!sku) break;
        const qty = Math.max(1, Math.floor(Number(params?.qty) || 1));
        const title = String(params?.title || '').trim();
        const p = state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku);
        addToCart(sku, qty, title, p);
        setCartOpen(true);
        break;
      }
      case 'addAllToCart': {
        const items = Array.isArray(params?.items) ? (params!.items as any[]) : [];
        if (items.length > 0) {
          (async () => {
            for (const item of items) {
              const sku = String(item?.sku || '').trim();
              if (!sku || /^unsku-/i.test(sku)) continue;
              const qty = Math.max(1, Math.floor(Number(item?.quantity ?? item?.qty) || 1));
              const title = String(item?.title || item?.name || '').trim();
              const p = state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku);
              await addToCart(sku, qty, title, p);
            }
            setCartOpen(true);
          })();
        }
        break;
      }
      case 'setQuantity': {
        const sku = String(params?.sku ?? '').trim();
        const qty = Math.max(0, Math.floor(Number(params?.qty ?? params?.quantity) || 0));
        if (sku) {
          setQuantity(sku, qty);
        }
        break;
      }
      case 'removeFromCart': {
        const sku = String(params?.sku ?? '').trim();
        if (sku) {
          removeFromCart(sku);
        }
        break;
      }
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
        if (params?.panel === 'quote' || params?.panel === 'cart' || params?.panel === 'bag') {
          setCartOpen(true);
        } else if (params?.panel) {
          dispatch({ type: 'SET_PHASE', phase: params.panel as any });
        }
        break;
      case 'openUrl':
        if (params?.url) window.open(String(params.url), '_blank', 'noopener');
        break;
      default: {
        const fallbackText = params?.text || params?.label || params?.value;
        if (fallbackText) {
          w.__journeySend?.(String(fallbackText));
        }
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch, handleApprove, addToCart, removeFromCart, setQuantity, setCartOpen]);
}

/** Every card list keyed by SKU (products, bundle items, quote lines, order
 *  lines, accessories) keeps one row per SKU. Retrieval can return two variant
 *  rows of the same product and not every mapper dedupes — React then warns
 *  about duplicate keys and may drop or double a tile. */
function dedupeSkuLists<T extends Record<string, unknown>>(state: T): T {
  const out: Record<string, unknown> = { ...state };
  for (const key of ['products', 'items', 'lines']) {
    const list = out[key];
    if (!Array.isArray(list)) continue;
    const seen = new Set<string>();
    out[key] = list.filter((p: any) => { const k = String(p?.sku || '').toUpperCase(); if (!k) return true; if (seen.has(k)) return false; seen.add(k); return true; });
  }
  if (Array.isArray(out.groups)) out.groups = (out.groups as any[]).map((g) => (g && Array.isArray(g.items) ? dedupeSkuLists(g) : g));
  return out as T;
}

/** One card, rendered inline at its place in the conversation thread. */
export function CardTile({ card, onAction }: { card: CardInstance; onAction: (name: string, params?: Record<string, unknown>) => void }) {
  const cfg = useStorefrontConfig();
  return (
    <div className="jx-root chat-inline-card" data-card-type={card.cardType}>
      <CardRenderer
        template={resolveTemplate(cfg, card.cardType)}
        // The brand's own logo backs any tile whose catalogue has no picture ("Image coming soon").
        state={{ ...dedupeSkuLists(card.state as Record<string, unknown>), brandLogo: cfg.theme?.logoUrl || null }}
        settings={cfg.uiTheme?.cards?.[card.cardType]?.options}
        onAction={(name, params) => onAction(name, { ...params, cardId: card.id })}
        stateKey={card.id}
      />
    </div>
  );
}
