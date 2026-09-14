'use client';

import React, { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';
import {
  JourneyState, INITIAL_STATE, Phase, ClarifyAnswers, DynamicQuestion, RecommendedProduct,
  FINISHES, DEFAULT_ADDONS, formatAUD, getStockInfo, BOMLine, QuoteTotals, ServerQuote,
  TeamDesignViews, RosterRow, CardInstance
} from '@/lib/types';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import {
  mapProductsCard, mapQuoteCard, mapGuideCard, mapAccessoriesCard, mapClarifyCard,
  mapWarrantyCard, mapFitmentCard, mapPlanCard, mapOrderStatusCard, mapHeroCard,
} from '@/lib/cards/mappers';

type Action =
  | { type: 'SET_PHASE'; phase: Phase }
  | { type: 'SET_QUOTE_DATA'; title: string; bom: BOMLine[]; jobId?: string; installationSummary?: string; warrantySummary?: string }
  | { type: 'SET_SCHOOL_RESEARCH'; research: any }
  | { type: 'SET_SERVER_QUOTE'; quote: ServerQuote }
  | { type: 'SET_ORDERING'; ordering: boolean; error?: string }
  | { type: 'ADD_MESSAGE'; role: 'ai' | 'user' | 'note'; text: string; head?: string }
  | { type: 'SET_CLARIFY'; key: keyof ClarifyAnswers; value: string }
  | { type: 'SET_DYNAMIC_QUESTIONS'; questions: DynamicQuestion[] }
  | { type: 'SET_DYNAMIC_ANSWER'; questionId: string; value: string }
  | { type: 'SET_RECOMMENDED_PRODUCTS'; products: RecommendedProduct[] }
  | { type: 'SET_FINISH'; finish: string }
  | { type: 'SET_QTY'; qty: number }
  | { type: 'TOGGLE_ADDON'; id: string }
  | { type: 'SET_REVEALED'; revealed: boolean }
  | { type: 'SET_TOAST'; show: boolean }
  | { type: 'SET_THINKING'; thinking: boolean }
  | { type: 'SET_ORDER_ID'; orderId: string }
  | { type: 'SET_PLACED_ORDER'; order: NonNullable<import('../lib/types').JourneyState['placedOrder']> }
  | { type: 'SET_GUIDE_STEPS'; steps: { id: string; title: string; description: string }[] }
  | { type: 'TOGGLE_GUIDE_STEP'; id: string }
  | { type: 'SET_ACCESSORIES'; accessories: import('../lib/types').AccessoryItem[] }
  | { type: 'SET_CHOICE'; choice: import('../lib/types').JourneyChoice }
  | { type: 'SET_DESIGN'; design: Partial<import('../lib/types').DesignSpec> }
  | { type: 'CLEAR_DESIGN' }
  | { type: 'SET_CONCEPT'; conceptId: string }
  | { type: 'SET_PROOF'; proofId: string }
  | { type: 'ADD_TO_KIT'; item: import('../lib/types').KitItem }
  | { type: 'REMOVE_FROM_KIT'; sku: string }
  | { type: 'LOAD_KIT_ITEM'; sku: string }
  | { type: 'SELECT_CHOICE'; value: string }
  | { type: 'SET_INSTALL_GUIDE'; installGuide: import('../lib/types').InstallGuide }
  | { type: 'SET_WARRANTY'; warranty: import('../lib/types').WarrantyInfo }
  // Coach team-order journey
  | { type: 'SET_TEAM_DESIGN'; teamDesign: Partial<TeamDesignViews> }
  | { type: 'SET_ROSTER'; roster: RosterRow[] }
  | { type: 'SET_SELECTED_PLAYER'; index: number }
  // Fitment guide
  | { type: 'SET_SIZE_RECOMMENDATION'; sizeRecommendation: import('../lib/types').SizeRecommendation }
  // PlaceMakers Project Plan & Branch Stock
  | { type: 'SET_PROJECT_PLAN'; projectPlan: import('../lib/types').ProjectPlan }
  | { type: 'SET_BRANCH_STOCK'; branchStock: import('../lib/types').BranchStockResponse }
  | { type: 'APPLY_QUOTE_BRANCH_STOCK'; branch: string; branchName: string; bySku: Record<string, { status: string; stockQty: number; collectionTimeframe: string; clickAndCollectReady: boolean }> }
  | { type: 'SET_SPACE_PLANNER_PARAMS'; params: { roomType?: string; wallWidthMm?: number } }
  | { type: 'RESTORE'; state: Partial<JourneyState> }
  | { type: 'RESET' }
  // ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ──────────────────
  // Pure card-stack ops. Cfg-aware MAPPING (legacy state → CardInstance,
  // e.g. reading cfg.fulfilment.branches into a quote card) happens in
  // JourneyProvider's card-sync effect below, which has access to
  // useStorefrontConfig() — the reducer itself stays config-free.
  | { type: 'PUSH_CARD'; card: CardInstance }
  | { type: 'SET_ACTIVE_CARD'; id: string }
  | { type: 'POP_CARD'; id?: string }
  | { type: 'PATCH_CARD'; id: string; state: Record<string, unknown> }
  | { type: 'SET_WORKING'; working: JourneyState['working'] }
  | { type: 'CLEAR_CARDS' };

function reducer(state: JourneyState, action: Action): JourneyState {
  switch (action.type) {
    case 'RESTORE':
      // AUG-89: rehydrate a conversation's saved panel journey (phase, products,
      // quote, design…). Merge over INITIAL_STATE so any field the snapshot
      // predates gets a sane default, and transient UI flags never persist.
      return { ...INITIAL_STATE, ...action.state, isThinking: false, showToast: false, ordering: false };
    case 'SET_PHASE':
      /* A quote the customer just asked for outranks a turn that was already
       * in flight when they asked. The agent finishes describing the garment
       * and emits its configurator view a second later, which threw the fresh
       * quote off the screen and looked exactly like the button had failed.
       * Only an explicit move somewhere new (or a fresh quote) takes over. */
      /* While the customer is choosing between concepts, the agent's own turn
       * ("I've opened the designer…") must not make the choice for them. Once a
       * design line IS chosen — by their click, or because they asked for one by
       * name — the designer is exactly where they should be. */
      if (state.phase === 'concepts' && action.phase === 'configurator' && !state.design?.designLine) {
        return state;
      }
      if (state.phase === 'quote' && action.phase === 'configurator' && state.serverQuote) {
        // Only when it is the SAME garment the quote already covers. Asking to
        // design something else after seeing the quote is a real request and
        // must still open the designer.
        const quoted = state.serverQuote.lines?.some((l) => l.sku === state.design?.sku);
        if (quoted) return state;
      }
      return { ...state, phase: action.phase };
    case 'SET_QUOTE_DATA':
      return {
        ...state,
        quoteTitle: action.title,
        customBom: action.bom,
        jobId: action.jobId,
        installationSummary: action.installationSummary,
        warrantySummary: action.warrantySummary
      };
    case 'SET_SCHOOL_RESEARCH': {
      // Live brand research (AUG-48). Shown in the 60% panel for the customer to
      // confirm BEFORE any product renders — colours are a proposal, not applied.
      /* Carry the researched colours into the design as DEFAULTS.
       *
       * The whole point of finding a school's colours is that everything after
       * arrives wearing them; without this the concepts and the first 3D render
       * came back in stock colours, and the customer had to name the very
       * colours we had just shown them. Only the palette-mapped names are used —
       * those are the ones the renderer can actually print — and anything the
       * customer has already chosen wins. */
      const mapped = (action.research?.colours || [])
        .map((c: any) => c?.mappedTo?.name)
        .filter(Boolean);
      const design = {
        ...(state.design || {}),
        ...(state.design?.baseColor ? {} : mapped[0] ? { baseColor: mapped[0] } : {}),
        ...(state.design?.accentColor ? {} : mapped[1] ? { accentColor: mapped[1] } : {}),
      };
      return { ...state, phase: 'research', schoolResearch: action.research, design };
    }
    case 'SET_SERVER_QUOTE':
      // Authoritative quote (P0-04). The client stores it verbatim and renders
      // its figures — it does NOT recompute any price or total.
      return {
        ...state,
        phase: 'quote',
        serverQuote: action.quote,
        quoteTitle: action.quote.title,
        jobId: action.quote.quoteId,
        installationSummary: action.quote.installationSummary,
        warrantySummary: action.quote.warrantySummary,
        leadTimeSummary: action.quote.leadTimeSummary,
        orderError: undefined,
      };
    case 'SET_ORDERING':
      return { ...state, ordering: action.ordering, orderError: action.error };
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: action.role,
            text: action.text,
            head: action.head,
          },
        ],
      };
    case 'SET_CLARIFY':
      return {
        ...state,
        clarify: { ...state.clarify, [action.key]: action.value },
        ...(action.key === 'finishQ' ? { finish: action.value } : {}),
      };
    case 'SET_DYNAMIC_QUESTIONS':
      return { ...state, dynamicQuestions: action.questions, dynamicAnswers: {} };
    case 'SET_DYNAMIC_ANSWER':
      return { ...state, dynamicAnswers: { ...state.dynamicAnswers, [action.questionId]: action.value } };
    case 'SET_RECOMMENDED_PRODUCTS':
      /* Presenting products OWNS the panel. The panel renders purely by phase, so
       * setting the products without moving the phase left a stale garment on
       * screen — the chat listed baseball jerseys while the 3D view still showed
       * the cap from an earlier turn, and the customer was told they were looking
       * at something they were not. Content and panel must never disagree. */
      /* One exception: re-listing the SAME products the customer has already
       * seen is the agent recapping, not presenting something new — and it must
       * not throw away a quote they just asked for. Money on screen stays on
       * screen until there is genuinely something else to show. */
      {
        const sameAsShown =
          state.recommendedProducts.length === action.products.length &&
          state.recommendedProducts.every((p, i) => p.sku === action.products[i]?.sku);
        if (state.phase === 'quote' && sameAsShown) {
          return { ...state, recommendedProducts: action.products };
        }
        return { ...state, recommendedProducts: action.products, phase: 'products' };
      }
    case 'SET_FINISH':
      return { ...state, finish: action.finish };
    case 'SET_QTY':
      return { ...state, qty: Math.max(1, action.qty) };
    case 'TOGGLE_ADDON':
      return {
        ...state,
        selectedAddons: state.selectedAddons.includes(action.id)
          ? state.selectedAddons.filter(x => x !== action.id)
          : [...state.selectedAddons, action.id],
      };
    case 'SET_REVEALED':
      return { ...state, revealed: action.revealed };
    case 'SET_TOAST':
      return { ...state, showToast: action.show };
    case 'SET_THINKING':
      return { ...state, isThinking: action.thinking };
    case 'SET_ORDER_ID':
      return { ...state, orderId: action.orderId };
    case 'SET_PLACED_ORDER':
      /* The order as the server states it. Kept verbatim: after the payment
         redirect the browser's own journey state is gone, and the confirmation
         must describe the real order rather than what this tab remembers. */
      return { ...state, placedOrder: action.order, orderId: action.order.orderId };
    case 'SET_GUIDE_STEPS':
      return { ...state, phase: 'guide', guideSteps: action.steps.map(s => ({ ...s, completed: false })) };
    case 'TOGGLE_GUIDE_STEP':
      return {
        ...state,
        guideSteps: state.guideSteps.map(step =>
          step.id === action.id ? { ...step, completed: !step.completed } : step
        )
      };
    case 'SET_ACCESSORIES':
      return { ...state, phase: 'accessories', accessories: action.accessories };
    case 'SET_DESIGN':
      // Merge, never replace: the agent sends only what CHANGED ("make it maroon"),
      // and the rest of the design must survive that turn.
      return { ...state, design: { ...(state.design || {}), ...action.design } };
    case 'ADD_TO_KIT': {
      // One garment per SKU: adding the same style again REPLACES its design
      // rather than stacking duplicates the customer never asked for.
      const rest = (state.kit || []).filter((k) => k.sku !== action.item.sku);
      return { ...state, kit: [...rest, action.item] };
    }
    case 'REMOVE_FROM_KIT':
      return { ...state, kit: (state.kit || []).filter((k) => k.sku !== action.sku) };
    case 'LOAD_KIT_ITEM': {
      // Bring a hung garment back to the stage with the design it was saved
      // with — the whole point of a rack is that nothing is lost.
      const item = (state.kit || []).find((k) => k.sku === action.sku);
      if (!item) return state;
      return { ...state, design: {
        sku: item.sku, designLine: item.designLine,
        baseColor: item.baseColor, accentColor: item.accentColor,
        name: item.name, number: item.number,
      } };
    }
    case 'CLEAR_DESIGN':
      // Moving to a different style starts a fresh garment. Merging across a
      // style change is what let the panel show the PREVIOUS item while the
      // agent narrated the new one — colours, design line and lettering all
      // belong to the style they were chosen for. (conceptId is kept — it is the
      // "your concept" reference for the design the customer is actively making.)
      return { ...state, design: {} };
    case 'SET_CONCEPT':
      // CDL Door A: pin the AI-generated concept image (by id) for this design.
      return { ...state, conceptId: action.conceptId };
    case 'SET_PROOF':
      // CDL Path A: the faithful "your artwork on our garment" proof — becomes
      // the hero image for artwork-heavy uploads. Also lands us on the
      // configurator phase so the panel shows it.
      return { ...state, proofId: action.proofId, phase: 'configurator' };
    case 'SET_CHOICE':
      return { ...state, phase: 'choice', choice: action.choice };
    case 'SELECT_CHOICE':
      return { ...state, choice: state.choice ? { ...state.choice, selected: action.value } : state.choice };
    case 'SET_INSTALL_GUIDE':
      return { ...state, phase: 'install', installGuide: action.installGuide };
    case 'SET_WARRANTY':
      return { ...state, phase: 'warranty', warranty: action.warranty };
    case 'SET_SIZE_RECOMMENDATION':
      return { ...state, phase: 'sizeRecommendation', sizeRecommendation: action.sizeRecommendation };
    case 'SET_TEAM_DESIGN':
      // Merge, never replace: a design "edit" re-generates all 4 views, but the
      // running brief and any view that failed this round should not vanish.
      return { ...state, phase: 'teamDesign', teamDesign: { ...(state.teamDesign || {}), ...action.teamDesign } };
    case 'SET_ROSTER':
      // Roster is set but the phase move is a SEPARATE, explicit step (the coach
      // reviews the parsed roster before moving on) — see 'teamRoster' phase.
      return { ...state, roster: action.roster };
    case 'SET_SELECTED_PLAYER':
      return { ...state, selectedPlayerIdx: action.index };
    case 'SET_PROJECT_PLAN':
      return { ...state, phase: 'projectPlan', projectPlan: action.projectPlan };
    case 'SET_BRANCH_STOCK':
      return { ...state, branchStock: action.branchStock };
    case 'APPLY_QUOTE_BRANCH_STOCK': {
      // Patches the AUTHORITATIVE server quote's own lines with a real,
      // per-branch stock check — until this fires, every line's `inStock` is
      // whatever the quote-building tool set (usually just `true`), not
      // anything branch-specific. Never touches price/totals; those stay
      // server-owned exactly as P0-04 established.
      if (!state.serverQuote) return { ...state, selectedBranch: action.branch, selectedBranchName: action.branchName };
      const lines = state.serverQuote.lines.map((l) => {
        const s = action.bySku[l.sku];
        if (!s) return l;
        return { ...l, inStock: s.clickAndCollectReady, branchStock: s };
      });
      return {
        ...state,
        selectedBranch: action.branch,
        selectedBranchName: action.branchName,
        serverQuote: { ...state.serverQuote, lines },
      };
    }
    case 'SET_SPACE_PLANNER_PARAMS':
      return { ...state, spacePlannerParams: action.params };

    // ── Card CMS (v3) ──────────────────────────────────────────────────
    case 'PUSH_CARD': {
      // A card REPLACES the most recent card of the same cardType (the agent
      // re-presenting products/a quote updates what's on stage, it doesn't
      // pile up a duplicate) unless the card opts into stacking via
      // variant:'append' (suggestion chips under whatever is already active).
      const append = action.card.variant === 'append';
      const cards = append
        ? [...state.cards, action.card]
        : [...state.cards.filter((c) => c.cardType !== action.card.cardType), action.card];
      // Cap the history strip so a long session doesn't grow this forever.
      const trimmed = cards.length > 12 ? cards.slice(cards.length - 12) : cards;
      return { ...state, cards: trimmed, activeCardId: action.card.id };
    }
    case 'SET_ACTIVE_CARD':
      return state.cards.some((c) => c.id === action.id) ? { ...state, activeCardId: action.id } : state;
    case 'POP_CARD': {
      const id = action.id ?? state.activeCardId;
      if (!id) return state;
      const cards = state.cards.filter((c) => c.id !== id);
      const activeCardId = state.activeCardId === id ? cards[cards.length - 1]?.id : state.activeCardId;
      return { ...state, cards, activeCardId };
    }
    case 'PATCH_CARD':
      return {
        ...state,
        cards: state.cards.map((c) => (c.id === action.id ? { ...c, state: { ...c.state, ...action.state } } : c)),
      };
    case 'SET_WORKING':
      return { ...state, working: action.working };
    case 'CLEAR_CARDS':
      return { ...state, cards: [], activeCardId: undefined };

    case 'RESET':
      return { ...INITIAL_STATE };
    default:
      return state;
  }
}

function calculateTotals(bom: BOMLine[], selectedAddons: string[], qty: number): QuoteTotals {
  const bomTotal = bom.reduce((s, line) => s + line.lineTotal, 0);
  const addonTotal = selectedAddons.reduce((s, id) => {
    const addon = DEFAULT_ADDONS.find(a => a.id === id);
    return s + (addon ? addon.price * qty : 0);
  }, 0);
  const subtotal = bomTotal + addonTotal;
  const discount = subtotal * 0.12;
  const afterDiscount = subtotal - discount;
  const gst = afterDiscount * 0.10;
  const total = afterDiscount + gst;
  return { subtotal, discount, gst, total };
}

// ── Context ────────────────────────────────────────────────────────────
interface JourneyContextType {
  state: JourneyState;
  dispatch: React.Dispatch<Action>;
  bom: BOMLine[];
  totals: QuoteTotals;
  quoteTitle: string;
  isDynamicClarifyComplete: boolean;
  handleApprove: () => void;
  handleRestart: () => void;
  handleTryRemove: () => void;
}

const JourneyContext = createContext<JourneyContextType | null>(null);

export function JourneyProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const cfg = useStorefrontConfig();

  // ── Card CMS card-sync (v3) ──────────────────────────────────────────
  // Mirrors legacy phase-driving state into `state.cards` so CardStage can
  // render it through a tenant's template instead of the matching React
  // panel. Lives here (not in the reducer) because several of these mappings
  // need `cfg` (fulfilment branches, intro copy) and the reducer is
  // deliberately config-free — see docs/v3-card-cms-architecture.md.
  const nextCardId = useRef(0);
  const newId = (cardType: string) => `${cardType}-${Date.now()}-${nextCardId.current++}`;

  // Backoffice "Cards & Theme" → Card gallery's per-card-type "Enabled"
  // checkbox (CardsTheme.tsx) — the ONE place that decides whether a tenant
  // sees a card type at all. Centralised here rather than in each effect
  // below so a disabled card type is skipped consistently and the reducer
  // stays config-free (see file-header note above).
  const pushCard = useCallback((card: CardInstance) => {
    if (cfg.uiTheme?.cards?.[card.cardType]?.enabled === false) return;
    dispatch({ type: 'PUSH_CARD', card });
  }, [cfg.uiTheme, dispatch]);

  useEffect(() => {
    if (state.recommendedProducts.length === 0) return;
    pushCard({ id: newId('products'), cardType: 'products', state: mapProductsCard(state.recommendedProducts) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.recommendedProducts]);

  useEffect(() => {
    if (!state.serverQuote) return;
    pushCard({
      id: newId('quote'), cardType: 'quote',
      state: mapQuoteCard(state.serverQuote, {
        fulfilment: cfg.fulfilment, selectedBranch: state.selectedBranch, selectedBranchName: state.selectedBranchName,
        quoteIntro: cfg.quoteIntro, complianceBadge: cfg.complianceBadge,
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.serverQuote, state.selectedBranch, state.selectedBranchName]);

  // Auto-check the FIRST configured branch as soon as a real quote with SKUs
  // exists — was PlaceMakers-only (`isPlaceMakers && bomSkuSig && !state.
  // selectedBranch` inside QuotePanel.tsx); now runs for any tenant whose
  // config actually lists fulfilment branches, so the "In Stock" status shown
  // is real from the first render instead of requiring an extra click.
  useEffect(() => {
    const branches = cfg.fulfilment?.branches;
    const skus = state.serverQuote?.lines?.filter((l) => l.sku).map((l) => l.sku);
    if (!branches?.length || !skus?.length || state.selectedBranch) return;
    const branchId = branches[0].id;
    let cancelled = false;
    (async () => {
      try {
        const items = state.serverQuote!.lines.filter((l) => l.sku).map((l) => ({ sku: l.sku, productTitle: l.name }));
        const res = await fetch('/api/branch-stock', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items, branch: branchId }),
        });
        const data = await res.json();
        if (cancelled || !data?.ok) return;
        const bySku: Record<string, any> = {};
        for (const r of data.results || []) bySku[r.sku] = r;
        dispatch({ type: 'APPLY_QUOTE_BRANCH_STOCK', branch: branchId, branchName: data.branchName || branchId, bySku });
      } catch { /* best-effort — the branch selector still works manually */ }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.serverQuote, cfg.fulfilment, state.selectedBranch]);

  useEffect(() => {
    if (state.guideSteps.length === 0) return;
    pushCard({ id: newId('guide'), cardType: 'guide', state: mapGuideCard(state.guideSteps) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.guideSteps]);

  useEffect(() => {
    if (!state.accessories?.length) return;
    pushCard({ id: newId('accessories'), cardType: 'accessories', state: mapAccessoriesCard(state.accessories) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.accessories]);

  useEffect(() => {
    if (state.dynamicQuestions.length === 0) return;
    pushCard({ id: newId('clarify'), cardType: 'clarify', state: mapClarifyCard(state.dynamicQuestions) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.dynamicQuestions]);

  useEffect(() => {
    if (!state.warranty) return;
    pushCard({ id: newId('warranty'), cardType: 'warranty', state: mapWarrantyCard(state.warranty) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.warranty]);

  useEffect(() => {
    if (!state.sizeRecommendation) return;
    pushCard({ id: newId('fitment'), cardType: 'fitment', state: mapFitmentCard(state.sizeRecommendation) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sizeRecommendation]);

  useEffect(() => {
    if (!state.projectPlan) return;
    pushCard({ id: newId('plan'), cardType: 'plan', state: mapPlanCard(state.projectPlan) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.projectPlan]);

  useEffect(() => {
    if (!state.placedOrder) return;
    pushCard({ id: newId('orderStatus'), cardType: 'orderStatus', state: mapOrderStatusCard(state.placedOrder) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.placedOrder]);

  useEffect(() => {
    if (state.phase !== 'intro' || state.cards.length > 0) return;
    pushCard({ id: newId('hero'), cardType: 'hero', state: mapHeroCard(cfg.intro, cfg.companyName, cfg.greeting) });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.phase, cfg.intro, cfg.companyName, cfg.greeting]);

  // P0-04: when the server quote is present it is the SINGLE source of truth for
  // both line items and money. The legacy browser-side calculateTotals path is a
  // fallback only for pre-quote states (it no longer drives real orders).
  const sq = state.serverQuote;
  const bom: BOMLine[] = sq
    ? sq.lines.map((l) => ({
        key: l.sku,
        id: l.sku,
        name: l.name,
        price: l.unitPrice ?? 0,
        spec: l.reason || l.category || '',
        sku: l.sku,
        imageUrl: l.imageUrl || undefined,
        category: l.category || '',
        required: !!l.required,
        reason: l.reason,
        quantity: l.quantity,
        lineTotal: l.lineTotal,
        // A real branch check (l.branchStock) overrides the generic "In
        // stock"/"Out of stock" fallback with the actual per-branch status
        // and collection timeframe once the customer has picked a branch.
        stock: l.branchStock
          ? {
              label: `${l.branchStock.status}${l.branchStock.clickAndCollectReady ? ` · ${l.branchStock.collectionTimeframe}` : ''}`,
              color: l.branchStock.status === 'In Stock' ? '#4E7C59' : l.branchStock.status === 'Low Stock' ? '#B58A3C' : '#B00020',
            }
          : { label: l.inStock ? 'In stock' : 'Out of stock', color: l.inStock ? '#4E7C59' : '#B58A3C' },
      }))
    : (state.customBom || []);
  const totals: QuoteTotals = sq
    ? { subtotal: sq.subtotal, discount: sq.discount, gst: sq.tax, total: sq.total }
    : calculateTotals(bom, state.selectedAddons, state.qty);

  const quoteTitle = state.quoteTitle || 'Your quote';

  // Dynamic clarify is complete when every dynamic question has an answer
  const isDynamicClarifyComplete = state.dynamicQuestions.length > 0 &&
    state.dynamicQuestions.every(q => !!state.dynamicAnswers[q.id]);

  // P0-04: "Approve" no longer mints a fake order in the browser. It commits the
  // authoritative quote server-side and redirects to a REAL Stripe Checkout. The
  // order only becomes "ordered" after Stripe confirms payment (handled on return).
  const stateRef = useRef(state);
  useEffect(() => { stateRef.current = state; });
  const handleApprove = useCallback(async () => {
    const quote = stateRef.current.serverQuote;
    if (!quote) return;
    if (!quote.validation.ok) {
      dispatch({ type: 'SET_ORDERING', ordering: false, error: quote.validation.errors.join(' ') || 'This quote has unresolved issues.' });
      return;
    }
    dispatch({ type: 'SET_ORDERING', ordering: true });
    try {
      const res = await fetch('/api/order' + (typeof window !== 'undefined' ? window.location.search : ''), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteId: quote.quoteId, idempotencyKey: quote.quoteId, quote }),
      });
      const data = await res.json();
      if (data?.success && data?.checkoutUrl) {
        window.location.href = data.checkoutUrl; // hosted Stripe Checkout (PCI stays with Stripe)
        return;
      }
      dispatch({ type: 'SET_ORDERING', ordering: false, error: data?.error || 'Could not start checkout. Please try again.' });
    } catch {
      dispatch({ type: 'SET_ORDERING', ordering: false, error: 'Network error starting checkout. Please try again.' });
    }
  }, []);

  const handleTryRemove = useCallback(() => {
    dispatch({
      type: 'ADD_MESSAGE',
      role: 'note',
      text: "That's a mandatory in-wall component — removing it would ship an incomplete order, so I'll keep it bundled.",
      head: 'Kept in.',
    });
  }, []);

  const handleRestart = useCallback(() => {
    dispatch({ type: 'RESET' });
  }, []);

  // P0-04: on return from Stripe (?order=<id>&status=success) poll the order until
  // the webhook has confirmed payment, THEN show "ordered". Never before.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('order');
    const status = params.get('status');
    if (status !== 'success' || !orderId) return;
    let tries = 0;
    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      tries++;
      try {
        const r = await fetch(`/api/order?orderId=${encodeURIComponent(orderId)}&${window.location.search.slice(1)}`, { cache: 'no-store' });
        const d = await r.json();
        if (d?.found && d.status === 'paid') {
          dispatch({ type: 'SET_PLACED_ORDER', order: d });
          dispatch({ type: 'SET_PHASE', phase: 'ordered' });
          return;
        }
      } catch { /* retry */ }
      if (tries < 12 && !cancelled) setTimeout(poll, 1500);
    };
    poll();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      (window as any).__journeyDispatch = dispatch;
      (window as any).__journeyState = state;
    }
  }, [state, dispatch]);

  return (
    <JourneyContext.Provider
      value={{
        state,
        dispatch,
        bom,
        totals,
        quoteTitle,
        isDynamicClarifyComplete,
        handleApprove,
        handleRestart,
        handleTryRemove,
      }}
    >
      {children}
    </JourneyContext.Provider>
  );
}

export function useJourney() {
  const ctx = useContext(JourneyContext);
  if (!ctx) throw new Error('useJourney must be inside JourneyProvider');
  return ctx;
}
