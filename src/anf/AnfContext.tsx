'use client';

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
} from 'react';
import {
  AnfState,
  AnfPhase,
  INITIAL_STATE,
  MsgRole,
  StyleQuestion,
  Product,
  BagItem,
  BagTotals,
  calcTotals,
} from './types';

type Action =
  | { type: 'SET_PHASE'; phase: AnfPhase }
  | { type: 'ADD_MESSAGE'; role: MsgRole; text: string; head?: string }
  | { type: 'SET_QUIZ'; questions: StyleQuestion[] }
  | { type: 'SET_QUIZ_ANSWER'; id: string; value: string }
  | { type: 'SET_RECOMMENDED'; products: Product[]; heroReason: string }
  | { type: 'ADD_TO_BAG'; item: Omit<BagItem, 'key' | 'qty'> }
  | { type: 'CHANGE_QTY'; key: string; delta: number }
  | { type: 'REMOVE_FROM_BAG'; key: string }
  | { type: 'SET_THINKING'; thinking: boolean }
  | { type: 'SET_ORDER'; orderId: string }
  | { type: 'RESET' };

function reducer(state: AnfState, action: Action): AnfState {
  switch (action.type) {
    case 'SET_PHASE':
      return { ...state, phase: action.phase };
    case 'ADD_MESSAGE':
      return {
        ...state,
        messages: [
          ...state.messages,
          {
            id: `m-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            role: action.role,
            text: action.text,
            head: action.head,
          },
        ],
      };
    case 'SET_QUIZ':
      return { ...state, quizQuestions: action.questions, quizAnswers: {} };
    case 'SET_QUIZ_ANSWER':
      return {
        ...state,
        quizAnswers: { ...state.quizAnswers, [action.id]: action.value },
      };
    case 'SET_RECOMMENDED':
      return {
        ...state,
        recommended: action.products,
        heroReason: action.heroReason,
      };
    case 'ADD_TO_BAG': {
      const key = `${action.item.productId}|${action.item.size}|${action.item.color}`;
      const existing = state.bag.find((b) => b.key === key);
      if (existing) {
        return {
          ...state,
          bag: state.bag.map((b) =>
            b.key === key ? { ...b, qty: b.qty + 1 } : b
          ),
        };
      }
      return { ...state, bag: [...state.bag, { ...action.item, key, qty: 1 }] };
    }
    case 'CHANGE_QTY':
      return {
        ...state,
        bag: state.bag
          .map((b) =>
            b.key === action.key ? { ...b, qty: b.qty + action.delta } : b
          )
          .filter((b) => b.qty > 0),
      };
    case 'REMOVE_FROM_BAG':
      return { ...state, bag: state.bag.filter((b) => b.key !== action.key) };
    case 'SET_THINKING':
      return { ...state, isThinking: action.thinking };
    case 'SET_ORDER':
      return { ...state, orderId: action.orderId, phase: 'confirmed' };
    case 'RESET':
      return {
        ...INITIAL_STATE,
        messages: [
          ...INITIAL_STATE.messages,
          {
            id: `m-reset-${Date.now()}`,
            role: 'ai',
            text: "Fresh start! What are we shopping for?",
          },
        ],
      };
    default:
      return state;
  }
}

interface AnfContextType {
  state: AnfState;
  dispatch: React.Dispatch<Action>;
  totals: BagTotals;
  quizComplete: boolean;
  placeOrder: () => void;
}

const AnfContext = createContext<AnfContextType | null>(null);

export function AnfProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  const totals = calcTotals(state.bag);

  const quizComplete =
    state.quizQuestions.length > 0 &&
    state.quizQuestions.every((q) => !!state.quizAnswers[q.id]);

  const placeOrder = useCallback(() => {
    const id = 'ANF-' + Math.floor(100000 + Math.random() * 899999);
    dispatch({ type: 'SET_ORDER', orderId: id });
    dispatch({
      type: 'ADD_MESSAGE',
      role: 'ai',
      text: `That's an order — ${id} is confirmed. You'll get a shipping note shortly, and your A&F member rewards are already applied. Anything else you'd like styled?`,
    });
  }, []);

  return (
    <AnfContext.Provider
      value={{ state, dispatch, totals, quizComplete, placeOrder }}
    >
      {children}
    </AnfContext.Provider>
  );
}

export function useAnf() {
  const ctx = useContext(AnfContext);
  if (!ctx) throw new Error('useAnf must be used inside AnfProvider');
  return ctx;
}
