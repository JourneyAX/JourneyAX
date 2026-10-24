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
import { useCallback, useEffect, useRef } from 'react';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { answerSummary } from '@journeyax/ui-cards/answers';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { resolveTemplate } from '@/lib/cards/resolveTemplate';
import { mapClarifyCard } from '@/lib/cards/mappers';
import { buildDetailProduct, fetchProductDetail } from '@/lib/cards/productDetail';
import { MAX_COMPARE, clearCompare, getCompareSelection, toggleCompare, useCompareSelection } from '@/lib/cards/compareStore';
import { decorateProductRows } from '@/lib/cards/productTiles';
import { buildComparisonCard, toCompareSource } from '@/lib/cards/comparison';
import { requestQuantity } from '@/lib/cards/quantityStep';
import type { CardInstance } from '@/lib/types';
import { openPanelCard, rememberPanelOpener } from '@/lib/shell/sidePanelStore';

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

function postCustomerEvent(event: { type: string; payload?: any; sourceCard?: any }) {
  if (typeof window !== 'undefined') {
    const w = window as any;
    if (typeof w.__journeySendEvent === 'function') {
      w.__journeySendEvent(event);
    } else {
      fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: w.__journeySessionId,
          workspaceId: w.__journeyWorkspaceId,
          customer_event: event,
        }),
      }).catch(() => {});
    }
  }
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
  // The quantity step calls back into this same handler once the customer has chosen a number.
  const selfRef = useRef<((name: string, params?: Record<string, unknown>) => void) | null>(null);

  const handler = useCallback((name: string, params?: Record<string, unknown>) => {
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
        postCustomerEvent({
          type: 'selectOption',
          payload: { questionId, value },
          sourceCard: { id: cardId, cardType: 'clarify' },
        });

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
            const clarificationText = `My answers:\n${answerSummary(updatedQuestions, answers)}`;
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

        postCustomerEvent({
          type: 'selectItem',
          payload: { sku, title, value, questionId },
          sourceCard: { id: params?.cardId, cardType: 'selection' },
        });

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
        postCustomerEvent({
          type: 'selectDesign',
          payload: { label, ...params },
          sourceCard: { id: params?.cardId },
        });
        w.__journeySend?.(`I choose ${label}`);
        break;
      }
      case 'nextStep':
      case 'next':
      case 'proceed':
      case 'continue': {
        const text = String(params?.text || params?.label || params?.step || 'Continue to next step').trim();
        postCustomerEvent({
          type: 'nextStep',
          payload: { text, ...params },
          sourceCard: { id: params?.cardId },
        });
        w.__journeySend?.(text);
        break;
      }
      case 'viewProduct': {
        const sku = String(params?.sku ?? '');
        // The tapped tile may belong to a bundle, comparison or accessories
        // card whose items never entered recommendedProducts — fall back to
        // whatever card is showing that SKU, so every tile opens its detail.
        const p = state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku);
        // The event names the product, not just its code: the thread then reads "View product: <name>" and the agent
        // knows which one the customer is looking at without having to guess from the last list it showed.
        const viewedTitle = p ? String((p as any).name || (p as any).title || '').trim() : '';
        // The details sit right under the customer's own "View product" line, ahead of the consultant's reply (see compareProducts).
        const at = String(((typeof window !== 'undefined' ? (window as any).__journeyMessageCount : undefined) ?? 0) + 1);
        // The details open in the side panel; remember what was pressed so closing the panel can hand focus back to it.
        rememberPanelOpener();
        postCustomerEvent({
          type: 'viewProduct',
          payload: { sku, ...(viewedTitle ? { title: viewedTitle } : {}) },
          sourceCard: { id: params?.cardId },
        });
        // The tile only knows a title, a price and a picture. The catalogue knows the rest (description, features,
        // specifications, documents, what goes with it, availability): ask for it, and open the card with whatever came back.
        // If the catalogue cannot answer, the card opens with the tile's own facts, as it always did.
        void (async () => {
          const detail = await fetchProductDetail(sku, cfgRef.current.projectId);
          if (!p && !detail) return;
          const product = buildDetailProduct(p as any, detail, sku);
          const detailId = `productDetail-${sku}-${Date.now()}`;
          openPanelCard(detailId, 'productDetail');
          dispatch({
            type: 'PUSH_CARD',
            card: {
              id: detailId,
              cardType: 'productDetail',
              beforeReply: true,
              state: {
                product,
                closing,
                handoff: matchHandoff(cfgRef.current.handoffs, { sku, name: String(product.title || ''), category: product.category as string | undefined }),
              },
              createdAt: at,
            },
          });
        })();
        break;
      }
      case 'toggleCompare': {
        const sku = String(params?.sku ?? '').trim();
        if (sku) toggleCompare({ sku, title: String(params?.title ?? '') });
        break;
      }
      case 'compareProducts': {
        const named = Array.isArray(params?.skus) ? (params!.skus as unknown[]).map((entry) => String(entry).trim()).filter(Boolean) : [];
        const skus = [...new Set(named.length > 0 ? named : getCompareSelection().map((entry) => entry.sku))].slice(0, MAX_COMPARE);
        if (skus.length < 2) break;
        const ticked = getCompareSelection();
        const tiles = skus.map((sku) => state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku));
        const titles = skus.map((sku, i) => String((tiles[i] as any)?.name || (tiles[i] as any)?.title || ticked.find((entry) => entry.sku === sku)?.title || sku));
        // The table belongs right under the customer's own "Compare products" line, before the consultant's reply: the position is
        // the thread length once that line is added, taken now because the reply starts streaming before the records come back.
        const at = String(((typeof window !== 'undefined' ? (window as any).__journeyMessageCount : undefined) ?? 0) + 1);
        // The consultant is told which products are being compared, so it can say which one fits what the customer asked for.
        rememberPanelOpener();
        postCustomerEvent({ type: 'compareProducts', payload: { skus, titles, title: titles.join(' vs ') }, sourceCard: { id: params?.cardId } });
        clearCompare();
        void (async () => {
          const details = await Promise.all(skus.map((sku) => fetchProductDetail(sku, cfgRef.current.projectId)));
          const comparisonId = `comparison-${skus.join('-')}-${Date.now()}`;
          openPanelCard(comparisonId, 'comparison');
          dispatch({
            type: 'PUSH_CARD',
            card: {
              id: comparisonId,
              cardType: 'comparison',
              beforeReply: true,
              state: buildComparisonCard(skus.map((sku, i) => toCompareSource(tiles[i] as any, details[i], sku))),
              createdAt: at,
            },
          });
        })();
        break;
      }
      case 'addToCart': {
        const sku = String(params?.sku ?? '').trim();
        if (!sku) break;
        const qty = Math.max(1, Math.floor(Number(params?.qty) || 1));
        const title = String(params?.title || '').trim();
        const p = state.recommendedProducts.find((r) => r.sku === sku) || findCardProduct(state.cards, sku);
        const name = title || p?.name || (p as any)?.title || sku;

        // Nothing is added blindly: the customer says how many first (or asks for help working it out from their area).
        // A tap that already carries a confirmed number (the quantity card's own button) goes straight through.
        if (params?.confirmed !== true) {
          requestQuantity({
            sku,
            title: name,
            imageUrl: (p as any)?.imageUrl ?? null,
            price: (p as any)?.price ?? null,
            initial: qty,
            onConfirm: (chosen) => selfRef.current?.('addToCart', { ...params, sku, title: name, qty: chosen, confirmed: true }),
            onWorkItOut: () => w.__journeySend?.(String((cfgRef.current as any)?.labels?.quantityHelpMessage || 'Help me work out how many I need of') + ` ${name}`),
          });
          break;
        }

        const cardId = params?.cardId ? String(params.cardId) : undefined;
        postCustomerEvent({
          type: 'addToCart',
          payload: { sku, quantity: qty, title: name },
          sourceCard: { id: cardId, cardType: 'products' },
        });

        // Optimistic UI feedback: immediately mark inBag so the button becomes 'Added ✓'
        if (cardId) {
          const card = state.cards.find((c) => c.id === cardId);
          if (card && card.cardType === 'products') {
            const prods = ((card.state as any)?.products || []).map((prod: any) =>
              String(prod.sku).toUpperCase() === sku.toUpperCase() ? { ...prod, inBag: true } : prod
            );
            dispatch({ type: 'PATCH_CARD', id: cardId, state: { products: prods } });
          }
        }

        // Await authoritative quote pricing then open drawer and confirm in conversation
        (async () => {
          await addToCart(sku, qty, title, p);
          // The list opens as the confirmation; the consultant's reply (its own turn) says what goes with it.
          setCartOpen(true);
        })();
        break;
      }
      case 'addAllToCart': {
        const items = Array.isArray(params?.items) ? (params!.items as any[]) : [];
        if (items.length > 0) {
          postCustomerEvent({
            type: 'addAllToCart',
            payload: { items: items.map((i) => ({ sku: i?.sku, quantity: i?.quantity ?? i?.qty, title: i?.title || i?.name })) },
            sourceCard: { cardType: 'products' },
          });
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
            dispatch({
              type: 'ADD_MESSAGE',
              role: 'ai',
              text: `Added ${items.length} items to your ${closing}. You can review your quote and check branch stock in the materials drawer.`,
            });
          })();
        }
        break;
      }
      case 'setQuantity': {
        const sku = String(params?.sku ?? '').trim();
        const qty = Math.max(0, Math.floor(Number(params?.qty ?? params?.quantity) || 0));
        if (sku) {
          postCustomerEvent({
            type: 'setQuantity',
            payload: { sku, quantity: qty },
            sourceCard: { cardType: 'cart' },
          });
          setQuantity(sku, qty);
        }
        break;
      }
      case 'removeFromCart': {
        const sku = String(params?.sku ?? '').trim();
        if (sku) {
          postCustomerEvent({
            type: 'removeFromCart',
            payload: { sku },
            sourceCard: { cardType: 'cart' },
          });
          removeFromCart(sku);
        }
        break;
      }
      case 'selectBranch': {
        const branchId = String(params?.branchId ?? '');
        if (!branchId) break;
        postCustomerEvent({
          type: 'selectBranch',
          payload: { branchId },
          sourceCard: { cardType: 'fulfilment' },
        });
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
  useEffect(() => { selfRef.current = handler; }, [handler]);
  return handler;
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
  const ticked = useCompareSelection();
  const base = dedupeSkuLists(card.state as Record<string, unknown>) as Record<string, unknown>;
  // Product rows carry what depends on this customer's moment: ticked for comparison, how many branches hold it, no price to show.
  const state = card.cardType === 'products' && Array.isArray(base.products)
    ? { ...base, products: decorateProductRows(base.products as any[], { comparing: new Set(ticked.map((entry) => entry.sku)) }) }
    : base;
  return (
    <div className="jx-root chat-inline-card" data-card-type={card.cardType}>
      <CardRenderer
        template={resolveTemplate(cfg, card.cardType)}
        // The brand's own logo backs any tile whose catalogue has no picture ("Image coming soon").
        state={{ ...state, brandLogo: cfg.theme?.logoUrl || null }}
        settings={cfg.uiTheme?.cards?.[card.cardType]?.options}
        onAction={(name, params) => onAction(name, { ...params, cardId: card.id })}
        stateKey={card.id}
      />
    </div>
  );
}
