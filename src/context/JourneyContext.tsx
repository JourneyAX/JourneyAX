'use client';

import React, { createContext, useContext, useReducer, useCallback, useRef, useState } from 'react';
import {
  JourneyState, INITIAL_STATE, Phase, ClarifyAnswers, DynamicQuestion, RecommendedProduct,
  FINISHES, DEFAULT_ADDONS, formatAUD, getStockInfo, BOMLine, QuoteTotals
} from '@/lib/types';
import { computeTotals } from '@/lib/pricing';
import { recordReturn } from '@/services/fit/return-store';

/**
 * Wearer id for the retail journey, where the shopper is the only wearer.
 * Stable within a session so a return recorded now informs a size suggested
 * later in the same visit.
 */
const SHOPPER_WEARER_ID = 'shopper';
import type { BodyEstimate, GarmentSpec, ZoneFit } from '@/lib/advisor-types';
import type { BagLine, ReturnReason, TryOnView } from '@/lib/shop-types';
import { EMPTY_RETURN, calculateBagTotals, sizeDeltaFromReason } from '@/lib/shop-types';
import type { BagTotals } from '@/lib/shop-types';
import type { LanguageCode } from '@/lib/i18n';
import { translator } from '@/lib/i18n';

type Action =
  | { type: 'SET_PHASE'; phase: Phase }
  | { type: 'SET_QUOTE_DATA'; title: string; bom: BOMLine[]; jobId?: string; installationSummary?: string; warrantySummary?: string }
  | { type: 'ADD_MESSAGE'; role: 'ai' | 'user' | 'note'; text: string; head?: string }
  | { type: 'SET_CLARIFY'; key: keyof ClarifyAnswers; value: string }
  | { type: 'SET_DYNAMIC_QUESTIONS'; questions: DynamicQuestion[] }
  | { type: 'SET_DYNAMIC_ANSWER'; questionId: string; value: string }
  | { type: 'SET_RECOMMENDED_PRODUCTS'; products: RecommendedProduct[] }
  | { type: 'SET_FINISH'; finish: string }
  | { type: 'SET_QTY'; qty: number }
  | { type: 'TOGGLE_ADDON'; id: string }
  | { type: 'SET_TOAST'; show: boolean }
  | { type: 'SET_THINKING'; thinking: boolean }
  | { type: 'SET_ORDER_ID'; orderId: string }
  | { type: 'SET_WELCOME'; text: string }
  | { type: 'SHOW_FIT_ADVISOR'; garment: GarmentSpec }
  | {
      type: 'SET_FIT_CHOICE';
      size: string;
      summary: string;
      body?: BodyEstimate;
      zones?: ZoneFit[];
    }
  | { type: 'CLOSE_FIT_ADVISOR' }
  | { type: 'SET_GUIDE_STEPS'; steps: { id: string; title: string; description: string }[] }
  | { type: 'TOGGLE_GUIDE_STEP'; id: string }
  // ── Apparel: bag, try-on, returns, language ──────────────────────────
  | { type: 'ADD_TO_BAG'; lines: Omit<BagLine, 'id'>[] }
  | { type: 'SET_BAG_LINE_SIZE'; lineId: string; size: string; rationale?: string }
  | { type: 'SET_BAG_LINE_QTY'; lineId: string; quantity: number }
  | { type: 'REMOVE_FROM_BAG'; lineId: string }
  | { type: 'SHOW_BAG' }
  | { type: 'SHOW_TRY_ON'; view: TryOnView }
  | { type: 'CLOSE_TRY_ON' }
  | { type: 'START_RETURN'; lineId?: string }
  | { type: 'SET_RETURN_LINE'; lineId: string }
  | { type: 'SET_RETURN_REASON'; reason: ReturnReason }
  | { type: 'RESOLVE_RETURN'; resolution: 'refund' | 'exchange'; exchangeSize?: string }
  | { type: 'SET_LANGUAGE'; language: LanguageCode }
  | { type: 'RESET' };

/** Bag line ids are generated here so callers never have to invent one. */
function newLineId() {
  return `bag-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

function reducer(state: JourneyState, action: Action): JourneyState {
  switch (action.type) {
    case 'SET_PHASE':
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
      return { ...state, recommendedProducts: action.products };
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
    case 'SET_TOAST':
      return { ...state, showToast: action.show };
    case 'SET_THINKING':
      return { ...state, isThinking: action.thinking };
    case 'SET_ORDER_ID':
      return { ...state, orderId: action.orderId };
    case 'SET_WELCOME':
      return {
        ...state,
        messages: state.messages.map(m => (m.id === 'welcome' ? { ...m, text: action.text } : m)),
      };
    // Like SET_GUIDE_STEPS, this moves the panel itself — the model asks for
    // a fit check and the right-hand side becomes the advisor.
    case 'SHOW_FIT_ADVISOR':
      return { ...state, phase: 'fit', fitGarment: action.garment, fitChoice: null };
    case 'SET_FIT_CHOICE': {
      // The size also lands on any bag line for this garment that is still
      // unsized — sizing an item you already put in the bag should not
      // require adding it a second time.
      const sku = state.fitGarment?.styleId;
      return {
        ...state,
        fitChoice: {
          size: action.size,
          summary: action.summary,
          body: action.body,
          zones: action.zones,
        },
        bag: sku
          ? state.bag.map(l =>
              l.sku === sku && !l.size
                ? { ...l, size: action.size, sizeRationale: action.summary }
                : l
            )
          : state.bag,
      };
    }
    case 'CLOSE_FIT_ADVISOR':
      return { ...state, fitGarment: null };
    case 'SET_GUIDE_STEPS':
      return { ...state, phase: 'guide', guideSteps: action.steps.map(s => ({ ...s, completed: false })) };
    case 'TOGGLE_GUIDE_STEP':
      return {
        ...state,
        guideSteps: state.guideSteps.map(step =>
          step.id === action.id ? { ...step, completed: !step.completed } : step
        )
      };
    // ── Bag ──────────────────────────────────────────────────────────
    // Merging rather than appending: the same style in the same size is one
    // line with a higher quantity, but the same style in a *different* size
    // is a separate line, because those are genuinely different garments.
    case 'ADD_TO_BAG': {
      const bag = [...state.bag];
      for (const incoming of action.lines) {
        const match = bag.findIndex(
          l => l.sku === incoming.sku && (l.size ?? '') === (incoming.size ?? '')
        );
        if (match >= 0) {
          bag[match] = { ...bag[match], quantity: bag[match].quantity + (incoming.quantity || 1) };
        } else {
          bag.push({ ...incoming, quantity: incoming.quantity || 1, id: newLineId() });
        }
      }
      // The advisor and try-on have done their job once the item is in the
      // bag. Leaving fitGarment set makes the phase-inference fallback drag
      // the panel back into a finished advisor on the next unrelated turn.
      return { ...state, bag, phase: 'bag', fitGarment: null, tryOn: null };
    }
    case 'SET_BAG_LINE_SIZE':
      return {
        ...state,
        bag: state.bag.map(l =>
          l.id === action.lineId
            ? { ...l, size: action.size, sizeRationale: action.rationale ?? l.sizeRationale }
            : l
        ),
      };
    case 'SET_BAG_LINE_QTY':
      return {
        ...state,
        bag: state.bag.map(l =>
          l.id === action.lineId ? { ...l, quantity: Math.max(1, action.quantity) } : l
        ),
      };
    case 'REMOVE_FROM_BAG':
      return { ...state, bag: state.bag.filter(l => l.id !== action.lineId) };
    case 'SHOW_BAG':
      return { ...state, phase: 'bag' };

    // ── Try-on ───────────────────────────────────────────────────────
    case 'SHOW_TRY_ON':
      return { ...state, phase: 'tryon', tryOn: action.view };
    case 'CLOSE_TRY_ON':
      return { ...state, tryOn: null };

    // ── Returns ──────────────────────────────────────────────────────
    case 'START_RETURN': {
      // Re-opening returns must not destroy a case already underway. The
      // message the panel sends when a return resolves ("I am returning the
      // tee…") reads as a return request itself, so this fires again right
      // after a resolution — without this guard the confirmation the shopper
      // just earned would vanish in front of them.
      const underway = state.returnCase.line || state.returnCase.stage !== 'choose-item';
      if (underway && !action.lineId) return { ...state, phase: 'returns' };

      const line = action.lineId ? state.bag.find(l => l.id === action.lineId) ?? null : null;
      return {
        ...state,
        phase: 'returns',
        returnCase: { ...EMPTY_RETURN, line, stage: line ? 'choose-reason' : 'choose-item' },
      };
    }
    case 'SET_RETURN_LINE': {
      const line = state.bag.find(l => l.id === action.lineId) ?? null;
      return { ...state, returnCase: { ...state.returnCase, line, stage: 'choose-reason' } };
    }
    case 'SET_RETURN_REASON':
      return { ...state, returnCase: { ...state.returnCase, reason: action.reason } };
    case 'RESOLVE_RETURN':
      return {
        ...state,
        returnCase: {
          ...state.returnCase,
          stage: 'resolved',
          resolution: action.resolution,
          exchangeSize: action.exchangeSize,
          // Only size-bearing reasons are written back as a fit signal. This
          // flag is what the panel reads to decide whether to claim it
          // learned something — claiming it learned from "wrong colour"
          // would be a lie the shopper can spot next time.
          fedToFitEngine: sizeDeltaFromReason(state.returnCase.reason) !== 0,
        },
      };

    case 'SET_LANGUAGE':
      return { ...state, language: action.language };

    case 'RESET':
      return { ...INITIAL_STATE };
    default:
      return state;
  }
}

/**
 * Client-side preview of the total.
 *
 * The maths now lives in `@/lib/pricing` so this and the server run the same
 * code. What the shopper sees here is still only a preview — `handleApprove`
 * will not create an order until `/api/quote` has confirmed the figure.
 */
function calculateTotals(bom: BOMLine[], selectedAddons: string[], qty: number): QuoteTotals {
  return computeTotals(bom, selectedAddons, qty);
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
  /** True while the server is confirming the price. */
  approving: boolean;
  /** Set when the server refused to price the quote. */
  quoteError: string | null;
  handleRestart: () => void;
  handleTryRemove: () => void;
  /** Apparel bag totals, derived rather than stored. */
  bagTotals: BagTotals;
  /** Resolve a UI string in the journey's current language. */
  t: (key: string) => string;
}

const JourneyContext = createContext<JourneyContextType | null>(null);

export function JourneyProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const bom = state.customBom || [];
  const totals = calculateTotals(bom, state.selectedAddons, state.qty);

  const quoteTitle = state.quoteTitle || 'Your bathroom project';

  const bagTotals = calculateBagTotals(state.bag);
  const t = translator(state.language);

  // Approval waits on the server's price confirmation, so the button needs a
  // pending state and somewhere to report a refusal.
  const [approving, setApproving] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);

  /**
   * Close the returns learning loop.
   *
   * The reducer stays pure, so the write happens here instead. A resolved
   * return is recorded exactly once — `recordedReturns` holds the line ids
   * already written, because the reducer legitimately re-renders the resolved
   * state several times and a return must not be logged twice.
   *
   * The shopper journey has one wearer (the shopper), so the id is
   * session-scoped. In the CSR journey the wearer is a real roster member and
   * carries their own id; this is the retail case only.
   */
  const recordedReturns = useRef<Set<string>>(new Set());
  React.useEffect(() => {
    const { stage, line, reason } = state.returnCase;
    if (stage !== 'resolved' || !line || !reason || !line.size) return;
    if (recordedReturns.current.has(line.id)) return;

    recordedReturns.current.add(line.id);
    recordReturn(SHOPPER_WEARER_ID, line.size, reason);
  }, [state.returnCase]);

  // Dynamic clarify is complete when every dynamic question has an answer
  const isDynamicClarifyComplete = state.dynamicQuestions.length > 0 &&
    state.dynamicQuestions.every(q => !!state.dynamicAnswers[q.id]);

  /**
   * Approve the quote.
   *
   * The total shown on screen was computed in this browser, so it is not
   * trusted to create an order. /api/orders/submit re-prices the same lines
   * server-side (the same verifyQuote used by /api/quote) and only persists
   * — and only returns an id — once it agrees. Before this route existed,
   * a client-generated id was the entire "order": nothing was ever written
   * anywhere, and no one but the shopper's own browser tab could ever see
   * what had been ordered.
   *
   * `source` is inferred from the jobId prefix rather than threaded through
   * as its own piece of state — Caroma mints "JOB-…", the shop journey mints
   * "AF-…", and that's already reliable per-tenant since each route
   * generates its own prefix.
   */
  const handleApprove = useCallback(async () => {
    setApproving(true);
    setQuoteError(null);
    try {
      const source = state.jobId?.startsWith('AF-') ? 'shop' : 'caroma';
      const res = await fetch('/api/orders/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          source, title: quoteTitle, jobId: state.jobId,
          bom, selectedAddons: state.selectedAddons, qty: state.qty,
        }),
      });

      if (!res.ok) {
        setQuoteError('We could not confirm the price just now. Please try again.');
        return;
      }

      const verdict = await res.json();
      if (!verdict.acceptable) {
        setQuoteError('Some lines on this quote could not be priced. A consultant will be in touch.');
        dispatch({
          type: 'ADD_MESSAGE',
          role: 'note',
          text: 'This quote needs a human check before it can be ordered.',
          head: 'Held for review.',
        });
        return;
      }

      const id = verdict.id;
      dispatch({ type: 'SET_ORDER_ID', orderId: id });
      dispatch({ type: 'SET_PHASE', phase: 'ordered' });
      dispatch({ type: 'SET_TOAST', show: false });
      dispatch({
        type: 'ADD_MESSAGE',
        role: 'ai',
        text: `Order ${id} created for ${formatAUD(verdict.totals.total)}. Fulfilment scheduled and the spec sheet is on its way to your account.`,
      });
    } catch {
      setQuoteError('We could not reach the pricing service. Please try again.');
    } finally {
      setApproving(false);
    }
  }, [bom, state.selectedAddons, state.qty, state.jobId, quoteTitle]);

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

  return (
    <JourneyContext.Provider
      value={{
        state,
        dispatch,
        bom,
        totals,
        quoteTitle,
        isDynamicClarifyComplete,
        bagTotals,
        t,
        handleApprove,
        approving,
        quoteError,
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
