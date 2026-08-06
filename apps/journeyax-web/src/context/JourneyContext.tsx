'use client';

import React, { createContext, useContext, useReducer, useCallback, useRef, useEffect } from 'react';
import {
  JourneyState, INITIAL_STATE, Phase, ClarifyAnswers, DynamicQuestion, RecommendedProduct,
  FINISHES, DEFAULT_ADDONS, formatAUD, getStockInfo, BOMLine, QuoteTotals, ServerQuote
} from '@/lib/types';

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
  | { type: 'ADD_TO_KIT'; item: import('../lib/types').KitItem }
  | { type: 'REMOVE_FROM_KIT'; sku: string }
  | { type: 'LOAD_KIT_ITEM'; sku: string }
  | { type: 'SELECT_CHOICE'; value: string }
  | { type: 'SET_INSTALL_GUIDE'; installGuide: import('../lib/types').InstallGuide }
  | { type: 'SET_WARRANTY'; warranty: import('../lib/types').WarrantyInfo }
  | { type: 'RESTORE'; state: Partial<JourneyState> }
  | { type: 'RESET' };

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
      // belong to the style they were chosen for.
      return { ...state, design: {} };
    case 'SET_CHOICE':
      return { ...state, phase: 'choice', choice: action.choice };
    case 'SELECT_CHOICE':
      return { ...state, choice: state.choice ? { ...state.choice, selected: action.value } : state.choice };
    case 'SET_INSTALL_GUIDE':
      return { ...state, phase: 'install', installGuide: action.installGuide };
    case 'SET_WARRANTY':
      return { ...state, phase: 'warranty', warranty: action.warranty };
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
        stock: { label: l.inStock ? 'In stock' : 'Out of stock', color: l.inStock ? '#4E7C59' : '#B58A3C' },
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
        body: JSON.stringify({ quoteId: quote.quoteId, idempotencyKey: quote.quoteId }),
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
