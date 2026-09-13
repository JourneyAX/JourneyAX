'use client';

/**
 * CardStage — renders the active card (docs/v3-card-cms-architecture.md).
 * Replaces the flat phase→panel switch in ProjectPanel for every card type
 * that has migrated. Legacy phases in LEGACY_CARD_PHASES still render their
 * bespoke React panel (see ProjectPanel.tsx) until they migrate too.
 */
import { useCallback, useMemo } from 'react';
import { CardRenderer } from '@journeyax/ui-cards/react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import { resolveTemplate } from '@/lib/cards/resolveTemplate';
import type { CardInstance } from '@/lib/types';

/** Action → storefront behaviour (docs/v3-card-cms-architecture.md §"Storefront action → behaviour map"). */
function useCardActions() {
  const { state, dispatch, handleApprove } = useJourney();

  return useCallback((name: string, params?: Record<string, unknown>) => {
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
        // Fire once every question on the active clarify card has an answer.
        const remaining = state.dynamicQuestions.filter((q) => q.id !== questionId && !state.dynamicAnswers[q.id]);
        if (remaining.length === 0) w.__handleClarifySubmit?.();
        break;
      }
      case 'viewProduct': {
        const sku = String(params?.sku ?? '');
        const p = state.recommendedProducts.find((r) => r.sku === sku);
        if (p) {
          dispatch({
            type: 'PUSH_CARD',
            card: {
              id: `productDetail-${sku}-${Date.now()}`,
              cardType: 'productDetail',
              state: { product: { sku, title: p.name, description: p.description, imageUrl: p.imageUrl || null, price: p.price ?? null, category: p.category, specs: p.specs } },
            },
          });
        }
        break;
      }
      case 'addToCart':
        w.__handleBuildQuote?.(params?.sku ? `Add SKU ${params.sku} (qty ${params?.qty ?? 1}) to my quote.` : undefined);
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
        w.__handleBuildQuote?.(`Remove SKU ${params?.sku} from my quote.`);
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
  }, [state, dispatch, handleApprove]);
}

export default function CardStage() {
  const { state, dispatch } = useJourney();
  const cfg = useStorefrontConfig();
  const onAction = useCardActions();

  const activeCard: CardInstance | undefined = useMemo(
    () => state.cards.find((c) => c.id === state.activeCardId) || state.cards[state.cards.length - 1],
    [state.cards, state.activeCardId],
  );
  const suggestionsCard = useMemo(
    () => [...state.cards].reverse().find((c) => c.cardType === 'suggestions'),
    [state.cards],
  );
  const history = useMemo(
    () => state.cards.filter((c) => c.cardType !== 'suggestions' && c.id !== activeCard?.id).slice(-5),
    [state.cards, activeCard],
  );

  if (!activeCard) return null;

  return (
    <div className="jx-root card-stage" data-card-type={activeCard.cardType}>
      {history.length > 0 && (
        <div className="card-stage-history">
          {history.map((c) => (
            <button key={c.id} type="button" className="card-stage-history-chip" onClick={() => dispatch({ type: 'SET_ACTIVE_CARD', id: c.id })}>
              {String((c.state as any)?.heading || (c.state as any)?.title || c.cardType)}
            </button>
          ))}
        </div>
      )}
      <CardRenderer
        key={activeCard.id}
        template={resolveTemplate(cfg, activeCard.cardType)}
        state={activeCard.state}
        settings={cfg.uiTheme?.cards?.[activeCard.cardType]?.options}
        onAction={onAction}
        stateKey={activeCard.id}
      />
      {suggestionsCard && (
        <div className="card-stage-suggestions">
          <CardRenderer
            key={suggestionsCard.id}
            template={resolveTemplate(cfg, 'suggestions')}
            state={suggestionsCard.state}
            onAction={onAction}
            stateKey={suggestionsCard.id}
          />
        </div>
      )}
    </div>
  );
}
