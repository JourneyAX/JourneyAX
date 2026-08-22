'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { resolveGarment } from '@/services/fit/garment-specs';
import MessageBubble from './MessageBubble';
import { CAROMA_TENANT, TenantConfig } from '@/lib/tenants';
import { isLanguageCode } from '@/lib/i18n';
import type { BagLine } from '@/lib/shop-types';
import LanguageSwitcher from './LanguageSwitcher';
import { logger } from '@/lib/logger';

const log = logger('ChatPanel');

/**
 * A message as it travels between this panel and the API.
 *
 * Wider than a display message: the server returns the full OpenAI-shaped
 * trace, including `role: 'tool'` entries and assistant turns whose content
 * is null because the substance is in `tool_calls`. Those are flattened to
 * text before the next request.
 */
interface ConversationMessage {
  role: string;
  content?: string | null;
  tool_calls?: { function?: { name?: string }; name?: string }[];
}

/**
 * A quote line as the model supplies it in `updateQuote`.
 *
 * Every field is optional because it comes from a language model, not from
 * our catalogue. `/api/quote` is what decides whether the resulting numbers
 * are fit to order on.
 */
interface QuoteItemArg {
  sku?: string;
  name?: string;
  price?: number;
  reason?: string;
  category?: string;
  imageUrl?: string;
  required?: boolean;
  quantity?: number;
}

/** A UI tool call returned by the server for the browser to replay. */
interface UiAction {
  name: string;
  // Shapes vary per tool and are narrowed at each call site.
  arguments: Record<string, unknown> & { items?: Record<string, unknown>[] };
}

/**
 * Panels reach back into the chat through these globals — a deliberate
 * choice documented in CLAUDE.md, not an accident. Declaring them here is
 * what lets that pattern typecheck without `any`.
 */
declare global {
  interface Window {
    __handleClarifySubmit?: () => void;
    /** Receives a plain-text summary of the shopper's selections. */
    __handleBuildQuote?: (summary: string) => void;
    __handleUserMessage?: (text: string) => void;
  }
}

export default function ChatPanel({ tenant = CAROMA_TENANT }: { tenant?: TenantConfig }) {
  const { state, dispatch } = useJourney();
  const stateRef = useRef(state);
  
  // Keep ref in sync with latest state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, state.isThinking]);

  // Greet as this tenant, not as whichever one wrote INITIAL_STATE.
  useEffect(() => {
    dispatch({ type: 'SET_WELCOME', text: tenant.welcome });
  }, [dispatch, tenant.welcome]);

  const sendToAI = useCallback(async (newMessages: ConversationMessage[]) => {
    setIsLoading(true);

    try {
      // Build clean message array for API
      const apiMessages = newMessages.map(m => {
        let content = m.content;
        if (!content && m.tool_calls) {
          // Summarize tool calls so context is preserved
          content = m.tool_calls.map(c => `[Action: ${c.function?.name || c.name}]`).join('\n');
        }
        return { role: m.role === 'assistant' ? 'assistant' : m.role, content: content || '' };
      }).filter(m => m.content); // Filter empty

      const res = await fetch(tenant.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ 
          messages: apiMessages,
          state: {
            phase: stateRef.current.phase,
            bom: stateRef.current.customBom || [],
            recommendedProducts: stateRef.current.recommendedProducts || [],
            finish: stateRef.current.finish || '',
            qty: stateRef.current.qty || 1,
            // Apparel journey context. Sent every turn for the same reason
            // the BOM is: there is no server-side session, so the bag and the
            // chosen language only exist if we keep telling the model.
            language: stateRef.current.language,
            bag: stateRef.current.bag || [],
            fitChoice: stateRef.current.fitChoice
              ? { size: stateRef.current.fitChoice.size }
              : null,
            returnStage: stateRef.current.returnCase.stage
          }
        })
      });

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(errorData.error || 'API Error');
      }
      
      const data = await res.json();

      // Update messages to the full conversation history from the backend (including tool calls/responses)
      if (data.conversation && data.conversation.length > 0) {
        setMessages(data.conversation);
      } else {
        const aiText = data.message?.content || '';
        if (aiText) {
          const updatedMessages = [...newMessages, { role: 'assistant', content: aiText }];
          setMessages(updatedMessages);
        }
      }

      let hasPhaseChange = false;
      // Process UI actions from the backend
      if (data.uiActions && data.uiActions.length > 0) {
        for (const action of data.uiActions) {
          if (action.name === 'setPhase') {
            hasPhaseChange = true;
            dispatch({ type: 'SET_PHASE', phase: action.arguments.phase });

            // If the AI sent dynamic questions with the clarify phase, set them
            if (action.arguments.phase === 'clarify' && action.arguments.questions) {
              dispatch({
                type: 'SET_DYNAMIC_QUESTIONS',
                questions: action.arguments.questions
              });
            }
          } else if (action.name === 'updateQuote') {
            // Transform the model's items into BOM lines.
            //
            // Every field is defended because the source is a language model.
            // This mapping previously emitted `id` while `BOMLine` declares
            // `key`, so every line carried an undefined key — invisible while
            // the array was typed `any[]`.
            const bom = (action.arguments.items as QuoteItemArg[]).map((item, i) => {
              const price = typeof item.price === 'number' && Number.isFinite(item.price) ? item.price : 0;
              const quantity = Number.isInteger(item.quantity) && (item.quantity as number) > 0
                ? (item.quantity as number)
                : 1;
              return {
                key: item.sku || `line-${i}`,
                name: item.name || 'Unnamed item',
                price,
                spec: item.reason || item.category || '',
                sku: item.sku,
                imageUrl: item.imageUrl || undefined,
                category: item.category || '',
                required: item.required || false,
                reason: item.reason,
                quantity,
                lineTotal: price * quantity,
                stock: { label: 'In stock · NSW DC', color: '#4E7C59' }
              };
            });
            dispatch({ 
              type: 'SET_QUOTE_DATA', 
              title: action.arguments.title, 
              bom,
              jobId: action.arguments.jobId,
              installationSummary: action.arguments.installationSummary,
              warrantySummary: action.arguments.warrantySummary
            });
          } else if (action.name === 'showProducts') {
            // Product recommendations — set them in state for ProductsPanel
            dispatch({
              type: 'SET_RECOMMENDED_PRODUCTS',
              products: action.arguments.products
            });
          } else if (action.name === 'showFitAdvisor') {
            // Resolve to a spec we trust: our own numbers when we hold the
            // style, otherwise the chart the model retrieved. If neither is
            // usable we show nothing rather than advise on invented figures.
            const garment = resolveGarment(action.arguments);
            if (garment) {
              dispatch({ type: 'SHOW_FIT_ADVISOR', garment });
              hasPhaseChange = true;
            }
          } else if (action.name === 'showGuide') {
            // Troubleshooting or installation guide steps
            dispatch({
              type: 'SET_GUIDE_STEPS',
              steps: action.arguments.steps
            });
            hasPhaseChange = true;
          } else if (action.name === 'addToBag') {
            // The bag accumulates, so this is an add, never a replace.
            dispatch({
              type: 'ADD_TO_BAG',
              lines: (action.arguments.items || []).map((i: Partial<BagLine>) => ({
                sku: i.sku ?? '',
                name: i.name ?? '',
                price: i.price ?? 0,
                quantity: i.quantity || 1,
                size: i.size,
                category: i.category,
                reason: i.reason,
              })),
            });
            hasPhaseChange = true;
          } else if (action.name === 'showBag') {
            dispatch({ type: 'SHOW_BAG' });
            hasPhaseChange = true;
          } else if (action.name === 'showTryOn') {
            // Try-on visualises a size the advisor already produced. If the
            // model did not pass one, fall back to the shopper's chosen size
            // rather than picking a size here — this panel must never be the
            // thing that decides a size.
            const size = action.arguments.size || stateRef.current.fitChoice?.size;
            if (size) {
              dispatch({
                type: 'SHOW_TRY_ON',
                view: {
                  styleId: action.arguments.styleId,
                  styleName: action.arguments.styleName,
                  size,
                  fitSummary: stateRef.current.fitChoice?.summary,
                },
              });
              hasPhaseChange = true;
            }
          } else if (action.name === 'startReturn') {
            dispatch({ type: 'START_RETURN' });
            hasPhaseChange = true;
          } else if (action.name === 'setLanguage') {
            const code = action.arguments.language;
            if (isLanguageCode(code)) {
              dispatch({ type: 'SET_LANGUAGE', language: code });
            }
          }
        }
        // If AI called updateQuote but forgot setPhase('quote'), do it
        if (!hasPhaseChange && data.uiActions.some((a: UiAction) => a.name === 'updateQuote')) {
          dispatch({ type: 'SET_PHASE', phase: 'quote' });
          hasPhaseChange = true;
        }
        // If AI called showProducts but forgot setPhase('products'), do it
        if (!hasPhaseChange && data.uiActions.some((a: UiAction) => a.name === 'showProducts')) {
          dispatch({ type: 'SET_PHASE', phase: 'products' });
          hasPhaseChange = true;
        }
      }
      
      // Safety: if we're stuck on 'validating' and the AI didn't transition us.
      // This also covers a bare language switch: the inference below lands on
      // whatever the shopper was actually doing (bag, try-on, advisor), which
      // is what makes changing language feel like nothing was reset.
      if (!hasPhaseChange) {
        const latestState = stateRef.current;
        // Fallback to the most relevant phase based on what we have in state
        if (latestState.customBom && latestState.customBom.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'quote' });
        } else if (latestState.guideSteps && latestState.guideSteps.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'guide' });
        } else if (latestState.fitGarment) {
          // The advisor is mid-flow — do not yank the panel out from under it.
          dispatch({ type: 'SET_PHASE', phase: 'fit' });
        } else if (latestState.returnCase.stage !== 'choose-item' || latestState.returnCase.line) {
          // A return in progress outranks the bag behind it.
          dispatch({ type: 'SET_PHASE', phase: 'returns' });
        } else if (latestState.tryOn) {
          dispatch({ type: 'SET_PHASE', phase: 'tryon' });
        } else if (latestState.bag.length > 0) {
          // A shopper with things in the bag should land back on the bag, not
          // be thrown to the intro screen.
          dispatch({ type: 'SET_PHASE', phase: 'bag' });
        } else if (latestState.recommendedProducts && latestState.recommendedProducts.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'products' });
        } else if (latestState.dynamicQuestions && latestState.dynamicQuestions.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'clarify' });
        } else {
          dispatch({ type: 'SET_PHASE', phase: 'intro' });
        }
      }
      dispatch({ type: 'SET_THINKING', thinking: false });
    } catch (err) {
      log.error('chat turn failed', err);
      // Show the shopper a sentence, not an exception. The server no longer
      // returns internal detail, so echoing `err.message` would only ever
      // surface transport noise like "Failed to fetch".
      setMessages(prev => [...prev, {
        role: 'assistant',
        content: 'Sorry — something went wrong on my end. Please try that again.',
      }]);
      dispatch({ type: 'SET_THINKING', thinking: false });
      dispatch({ type: 'SET_PHASE', phase: 'intro' }); // Reset phase on error
    } finally {
      setIsLoading(false);
    }
  }, [dispatch, tenant.endpoint]);

  // Called when user types a message
  const append = useCallback(async (msg: { role: string; content: string }) => {
    const newMessages = [...messages, msg];
    setMessages(newMessages);
    await sendToAI(newMessages);
  }, [messages, sendToAI]);

  // Called when user submits clarify answers from the right panel
  const handleClarifySubmit = useCallback(async () => {
    // Format answers as a readable message
    const answers = state.dynamicAnswers;
    const questions = state.dynamicQuestions;
    const answerSummary = questions
      .map(q => `${q.title} → ${answers[q.id] || 'Not answered'}`)
      .join('\n');

    const userMsg = { role: 'user', content: `My answers:\n${answerSummary}` };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    dispatch({ type: 'SET_PHASE', phase: 'validating' });
    dispatch({ type: 'SET_THINKING', thinking: true });

    await sendToAI(newMessages);

    dispatch({ type: 'SET_THINKING', thinking: false });
  }, [messages, state.dynamicAnswers, state.dynamicQuestions, sendToAI, dispatch]);

  // Expose handleClarifySubmit globally so ClarifyPanel can call it
  useEffect(() => {
    window.__handleClarifySubmit = handleClarifySubmit;
    return () => { delete window.__handleClarifySubmit; };
  }, [handleClarifySubmit]);

  // Called when user clicks "Build Quote" on ProductsPanel
  const handleBuildQuote = useCallback(async (summary?: string) => {
    const content = summary || 'Build my quote with the recommended products';
    const userMsg = { role: 'user', content };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    dispatch({ type: 'SET_PHASE', phase: 'validating' });
    dispatch({ type: 'SET_THINKING', thinking: true });

    await sendToAI(newMessages);

    dispatch({ type: 'SET_THINKING', thinking: false });
  }, [messages, sendToAI, dispatch]);

  // Expose handleBuildQuote globally so ProductsPanel can call it
  useEffect(() => {
    window.__handleBuildQuote = handleBuildQuote;
    return () => { delete window.__handleBuildQuote; };
  }, [handleBuildQuote]);

  // Expose handleUserMessage globally so GuidePanel can send arbitrary messages back to AI
  const handleUserMessage = useCallback(async (text: string) => {
    const userMsg = { role: 'user', content: text };
    const newMessages = [...messages, userMsg];
    setMessages(newMessages);

    dispatch({ type: 'SET_PHASE', phase: 'validating' });
    dispatch({ type: 'SET_THINKING', thinking: true });

    await sendToAI(newMessages);

    dispatch({ type: 'SET_THINKING', thinking: false });
  }, [messages, sendToAI, dispatch]);

  useEffect(() => {
    window.__handleUserMessage = handleUserMessage;
    return () => { delete window.__handleUserMessage; };
  }, [handleUserMessage]);


  const onSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!prompt.trim()) return;
    append({ role: 'user', content: prompt });
    setPrompt('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Merge context messages (welcome) with chat messages
  const allMessages = [...state.messages, ...messages.map((m, i) => ({
    id: `msg-${i}`,
    role: m.role as 'user' | 'ai' | 'note',
    text: m.content || ''
  }))].filter(m => m.text);

  return (
    <div className="chat-panel">
      {/* Header */}
      <div className="chat-header">
        <div className="chat-header__brand">{tenant.brand}</div>
        <div className="chat-header__divider" />
        <div className="chat-header__info">
          <div className="chat-header__title">{tenant.title}</div>
          <div className="chat-header__subtitle">{tenant.subtitle}</div>
        </div>
        {tenant.shopFeatures ? (
          <div className="chat-header__shop">
            <LanguageSwitcher />
            <button
              type="button"
              className="chat-header__bag"
              onClick={() => dispatch({ type: 'SHOW_BAG' })}
              aria-label="Open bag"
            >
              <span className="chat-header__bag-icon" aria-hidden>◫</span>
              <span className="chat-header__bag-count">
                {state.bag.reduce((n, l) => n + l.quantity, 0)}
              </span>
            </button>
          </div>
        ) : (
          <div className="chat-header__badge">
            <span className="chat-header__badge-dot" />
            <span className="chat-header__badge-text">{tenant.badge}</span>
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="chat-messages">
        {allMessages.map(msg => (
          <MessageBubble key={msg.id} message={msg} />
        ))}
        {(state.isThinking || isLoading) && (
          <div className="thinking">
            <span className="thinking__dot" />
            <span className="thinking__dot" />
            <span className="thinking__dot" />
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="chat-input-area">
        {state.phase === 'intro' && (
          <div className="chat-suggestions">
            {tenant.suggestions.map(text => (
              <div
                key={text}
                className="chat-suggestion"
                onClick={() => append({ role: 'user', content: text })}
              >
                <span className="chat-suggestion__arrow">→</span>
                {text}
              </div>
            ))}
          </div>
        )}
        <form className="chat-input-row" onSubmit={onSubmit}>
          <input
            className="chat-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={tenant.placeholder}
          />
          <button type="submit" className="chat-send-btn" aria-label="Send message">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
              <path d="M4 12h13M11 5l7 7-7 7" stroke="#F7F4EE" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
        </form>
      </div>
    </div>
  );
}
