'use client';

import { useRef, useEffect, useState, useCallback } from 'react';
import { useJourney } from '@/context/JourneyContext';
import { useStorefrontConfig } from '@/context/StorefrontConfigContext';
import {
  type Conversation, resolveActiveConversation, saveConversations, setActiveConversation,
  messagesKey, sessionKey, journeyKey, newId, summarise,
} from '@/lib/conversations';
import MessageBubble from './MessageBubble';

/**
 * Stream a chat turn via SSE. Live-updates the assistant message on each `token`
 * and returns the final `done` payload (same shape as the buffered response).
 * Throws on any failure so the caller can fall back to the buffered endpoint.
 */
async function streamChat(
  body: string,
  newMessages: any[],
  setMessages: (m: any[]) => void,
  tenantId?: string,
): Promise<any> {
  const res = await fetch('/api/chat/stream', {
    method: 'POST',
    // Pin the chat to the tenant this storefront resolved (multi-storefront routing).
    headers: { 'Content-Type': 'application/json', ...(tenantId ? { 'X-Tenant-ID': tenantId } : {}) },
    body,
  });
  if (!res.ok || !res.body) throw new Error('stream unavailable');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let streamText = '';
  let doneData: any = null;
  // Accumulate UI actions as they stream, so we can still render the result even
  // if the connection ends without a clean `done` event (happens on the slow
  // quote turn, which has a long silent gap while the BOM is assembled).
  const streamedUiActions: any[] = [];

  const handleFrame = (evt: string) => {
    const evLine = evt.split('\n').find((l) => l.startsWith('event:'));
    const dataLine = evt.split('\n').find((l) => l.startsWith('data:'));
    if (!evLine || !dataLine) return;
    const ev = evLine.slice(6).trim();
    let payload: any;
    try { payload = JSON.parse(dataLine.slice(5).trim()); } catch { return; }
    if (ev === 'token') {
      streamText += payload.delta || '';
      setMessages([...newMessages, { role: 'assistant', content: streamText }]);
    } else if (ev === 'uiAction') {
      streamedUiActions.push(payload);
    } else if (ev === 'done') {
      doneData = payload;
    } else if (ev === 'error') {
      throw new Error(payload.message || 'stream error');
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      handleFrame(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  /* The last frame carries the sessionId — and it is the one most likely to
   * arrive without the blank line that separates frames, in which case it sat
   * in this buffer and was thrown away. The client then never learned its own
   * session id, so every turn opened a fresh one: the conversation was rebuilt
   * from nothing, and anything the server remembered (the roster size, what has
   * been shown) was unreachable. Drain whatever is left before giving up. */
  if (buffer.trim()) handleFrame(buffer);
  if (doneData) {
    /* Belt-and-braces: the `done` frame normally carries the full uiActions, but
     * if any streamed uiAction (showItems/setPhase/…) is missing from it, keep the
     * streamed one — otherwise the 60% panel silently misses that render. Union by
     * tool name + arguments so nothing is applied twice. */
    const doneUi: any[] = Array.isArray(doneData.uiActions) ? doneData.uiActions : [];
    const keyOf = (a: any) => `${a?.name}:${typeof a?.arguments === 'string' ? a.arguments : JSON.stringify(a?.arguments ?? {})}`;
    const seen = new Set(doneUi.map(keyOf));
    const merged = [...doneUi, ...streamedUiActions.filter((a) => !seen.has(keyOf(a)))];
    return { ...doneData, uiActions: merged };
  }
  // No clean `done` — reconstruct from what streamed. As long as we got text or a
  // UI action (e.g. the quote), render it rather than throwing into the buffered
  // error path. sessionId is left as-is (kept from the prior turn).
  if (streamText || streamedUiActions.length) {
    return {
      message: { role: 'assistant', content: streamText },
      uiActions: streamedUiActions,
      conversation: [],
    };
  }
  throw new Error('stream produced no output');
}

export default function ChatPanel() {
  const { state, dispatch, bom } = useJourney();
  const cfg = useStorefrontConfig();
  // Retail bag affordance: a cart brand always needs a way BACK to its bag. Once
  // the complete-the-look step takes over the panel, the bag is no longer the
  // terminal view — this persistent header button returns to it any time.
  const isCart = (cfg as any)?.commerceMode === 'cart';
  const bagCount = (bom || []).reduce((n, l) => n + (l.quantity ?? 1), 0);
  // The send handlers below are useCallback closures created BEFORE the config
  // fetch resolves — reading `cfg` inside them would pin the DEFAULT tenant
  // (stale-closure bug). Always read the live value through this ref.
  const cfgRef = useRef(cfg);
  cfgRef.current = cfg;

  // Opening-screen copy. Tenants set their own vertical-true starters + placeholder
  // in the back office; when unset we derive label-based defaults (never a generic
  // "product, quantity, finish" example). Every starter routes through the agent
  // (append a user turn) rather than hard-jumping a phase, so the conversation —
  // research, colour confirmation, concepts — happens before anything renders.
  const itemSingular = (cfg.labels.itemsSingular || 'product').toLowerCase();
  const introStarters = (cfg.intro?.starters && cfg.intro.starters.length)
    ? cfg.intro.starters
    : [
        { label: `Help me choose the right ${itemSingular}`, prompt: `Help me choose the right ${itemSingular} — I'll tell you what I need.` },
        { label: 'I’d like a full recommendation — ask me what you need', prompt: `I'd like a full recommendation — ask me whatever you need to know.` },
      ];
  const introPlaceholder = cfg.intro?.inputPlaceholder
    || (cfg.configurator?.productType === 'garment'
      ? 'Tell me the team, the garment and how many…'
      : `Tell me what you’re looking for…`);

  const stateRef = useRef(state);
  
  // Keep ref in sync with latest state
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const [messages, setMessages] = useState<any[]>([]);
  const [prompt, setPrompt] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [displayName, setDisplayName] = useState<string>('');
  const [convoId, setConvoId] = useState('');
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [convoMenuOpen, setConvoMenuOpen] = useState(false);
  // sendToAI is a stable closure; reading convoId directly would pin whichever
  // thread was open when it was created.
  const convoIdRef = useRef('');
  convoIdRef.current = convoId;
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // CDL "upload my design": a design image the customer attached for the NEXT
  // message. sendToAI is a stable closure, so it reads the current value from a
  // ref (mirrors convoIdRef). Cleared once the message is sent.
  const [pendingImage, setPendingImage] = useState<{ dataUrl: string; name: string } | null>(null);
  const pendingImageRef = useRef<{ dataUrl: string; name: string } | null>(null);
  pendingImageRef.current = pendingImage;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const readImageFile = useCallback((file: File | null | undefined) => {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => setPendingImage({ dataUrl: String(reader.result || ''), name: file.name || 'design' });
    reader.readAsDataURL(file);
  }, []);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isLoading, state.isThinking]);

  // Conversation survives a refresh. The chat used to blank out on reload because
  // `messages` is client state; persist it per session and restore on mount so the
  // customer picks up exactly where they left off. Keyed by project + session id.
  const msgKey = convoId ? messagesKey(cfg.projectId, convoId) : '';

  /* AUG-89: rehydrate the 60% panel for a conversation. Each thread snapshots its
   * own journey (phase, products, quote, design…); reopening it must replay that
   * journey, not reset to the intro hero (which left the chat full of products
   * while the panel sat blank). Falls back to RESET when a thread has no snapshot.
   * `journeyReadyRef` gates the persist effect so the brief default-tenant mount
   * never writes a pristine INITIAL_STATE over a real saved snapshot. */
  const journeyReadyRef = useRef(false);
  const restoreJourney = useCallback((projectId: string | undefined, id: string) => {
    journeyReadyRef.current = false;
    let snap: any = null;
    try {
      const raw = localStorage.getItem(journeyKey(projectId, id));
      snap = raw ? JSON.parse(raw) : null;
    } catch { /* corrupt storage — start clean */ }
    if (snap && typeof snap === 'object' && snap.phase) dispatch({ type: 'RESTORE', state: snap });
    else dispatch({ type: 'RESET' });
    journeyReadyRef.current = true;
  }, [dispatch]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const { id, list } = resolveActiveConversation(cfg.projectId);
    setConvoId(id);
    setConvos(list);
    restoreJourney(cfg.projectId, id);
    try {
      /* ALWAYS reset the thread to THIS project's active conversation.
       *
       * The storefront mounts with the default projectId ("caroma") for the
       * instant before /api/config resolves the real tenant. That first pass
       * loaded Caroma's saved conversation into the panel; when the project
       * then flipped to (say) mms, this effect re-ran — but it only ever
       * *set* messages when the new project had saved history, and never
       * *cleared* them otherwise. So Caroma's chat stayed on screen under the
       * M&M'S greeting. Opening a new conversation looked fine only because it
       * clears explicitly. Reset unconditionally: a project with no saved
       * thread must show an empty panel, never the previous tenant's. */
      const saved = localStorage.getItem(messagesKey(cfg.projectId, id));
      const parsed = saved ? JSON.parse(saved) : null;
      setMessages(Array.isArray(parsed) && parsed.length ? parsed : []);
      setDisplayName(localStorage.getItem(`jx_name::${cfg.projectId || 'default'}`) || '');
    } catch { setMessages([]); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.projectId]);
  const restoredRef = useRef(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !msgKey || !convoId) return;
    try {
      if (messages.length) {
        localStorage.setItem(msgKey, JSON.stringify(messages.slice(-40)));
        // Keep the thread's label and its place in the list current, so the
        // switcher describes the conversation rather than listing timestamps.
        setConvos((prev) => {
          const title = summarise(messages.find((m: any) => m?.role === 'user')?.content);
          const next = prev.map((c) => (c.id === convoId ? { ...c, title, updatedAt: Date.now() } : c));
          saveConversations(cfg.projectId, next);
          return next;
        });
      } else if (restoredRef.current) {
        // Emptied AFTER first render (a Restart) → clear the saved chat + session
        // so a new configuration starts clean instead of resurrecting the old one.
        localStorage.removeItem(msgKey);
        localStorage.removeItem(sessionKey(cfg.projectId, convoId));
        localStorage.removeItem(journeyKey(cfg.projectId, convoId)); // AUG-89
      }
      restoredRef.current = true;
    } catch { /* quota — best effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, msgKey, convoId]);

  /* AUG-89: snapshot this conversation's panel journey on every change, so a
   * reload or thread-switch replays exactly what the customer last saw. Gated by
   * `journeyReadyRef` (see restoreJourney) so it can't clobber a saved snapshot
   * before that thread has been restored. Transient UI flags are dropped by the
   * RESTORE reducer, so persisting them here is harmless. */
  useEffect(() => {
    if (typeof window === 'undefined' || !convoId || !journeyReadyRef.current) return;
    try {
      localStorage.setItem(journeyKey(cfg.projectId, convoId), JSON.stringify(state));
    } catch { /* quota — best effort */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, convoId, cfg.projectId]);

  /* Strip transient checkout params (?order=…&status=success) from the URL,
   * keeping ?project. Left behind, they re-fire the Stripe-return poll on the
   * next reload and hijack a brand-new conversation back to the "ordered"
   * screen — so a new/switched thread must always start from a clean URL. */
  const clearCheckoutParams = useCallback(() => {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    if (!url.searchParams.has('order') && !url.searchParams.has('status')) return;
    url.searchParams.delete('order');
    url.searchParams.delete('status');
    window.history.replaceState({}, '', url.toString());
  }, []);

  /* Start a clean thread: new conversation id, so the next turn opens a NEW
   * server session and the agent begins with no memory of the last brief. */
  const startNewConversation = useCallback(() => {
    const id = newId();
    const next = [{ id, title: 'New conversation', updatedAt: Date.now() }, ...convos];
    saveConversations(cfg.projectId, next);
    setActiveConversation(cfg.projectId, id);
    setConvos(next);
    setConvoId(id);
    setMessages([]);
    dispatch({ type: 'RESET' });
    // AUG-89: a brand-new thread starts with no saved journey; drop any stale
    // snapshot under this id and enable persistence for the turns that follow.
    try { localStorage.removeItem(journeyKey(cfg.projectId, id)); } catch { /* best effort */ }
    journeyReadyRef.current = true;
    clearCheckoutParams();
    setConvoMenuOpen(false);
  }, [convos, cfg.projectId, dispatch, clearCheckoutParams, restoreJourney]);

  /* Switch threads. The transcript comes back from storage; the panel resets to
   * the start rather than showing the previous thread's garment or quote, which
   * would belong to a different conversation. */
  const openConversation = useCallback((id: string) => {
    if (id === convoId) { setConvoMenuOpen(false); return; }
    setActiveConversation(cfg.projectId, id);
    setConvoId(id);
    let restored: any[] = [];
    try {
      const saved = localStorage.getItem(messagesKey(cfg.projectId, id));
      const parsed = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed)) restored = parsed;
    } catch { /* ignore corrupt storage */ }
    setMessages(restored);
    // AUG-89: replay THIS thread's saved panel journey instead of resetting to
    // intro — the whole point of switching back to a conversation.
    restoreJourney(cfg.projectId, id);
    clearCheckoutParams();
    setConvoMenuOpen(false);
  }, [convoId, cfg.projectId, dispatch, restoreJourney]);

  // Lightweight customer sign-in: captures a display name for the session (real
  // storefront accounts/long-term memory land later). Honest affordance, not a
  // dead button — it greets them and persists across refresh.
  const onSignIn = useCallback(() => {
    if (typeof window === 'undefined') return;
    const key = `jx_name::${cfg.projectId || 'default'}`;
    const current = localStorage.getItem(key) || '';
    const next = window.prompt('Your name (so we can personalise your kit):', current);
    if (next === null) return;
    const trimmed = next.trim();
    localStorage.setItem(key, trimmed);
    setDisplayName(trimmed);
  }, [cfg.projectId]);

  const sendToAI = useCallback(async (newMessages: any[]) => {
    setIsLoading(true);
    // The user can switch/start a new conversation while this turn is still in
    // flight (e.g. impatient-retry during a slow "busy" turn). Pin the thread
    // this call was made for, and drop the response — never touch messages or
    // the journey panel — if the user has since moved to a different thread.
    // Without this, a stale response lands on the NEW conversation's state and
    // gets persisted under the NEW conversation's localStorage key, silently
    // resurrecting the old thread's transcript.
    const startedConvoId = convoIdRef.current;
    const isCurrent = () => convoIdRef.current === startedConvoId;
    const guardedSetMessages = (m: any[]) => { if (isCurrent()) setMessages(m); };

    try {
      // CLIENT-MINIMAL CONTRACT: the browser sends only the NEW user message + the
      // sessionId. The server owns the transcript and journey state and
      // reconstructs everything (no conversation/state is shipped from the client).
      const newUserMessage = [...newMessages].reverse().find(m => m.role === 'user')?.content || '';

      // Session id is the only durable handle the client keeps, per tenant.
      // Per CONVERSATION, not per project: each thread carries its own server
      // session, so switching threads switches what the agent remembers.
      const sKey = sessionKey(cfgRef.current.projectId, convoIdRef.current);
      const existingSessionId =
        typeof window !== 'undefined' ? localStorage.getItem(sKey) || undefined : undefined;

      // CDL: a design image attached this turn rides along as a data URL. The
      // agent holds it server-side and reads it with analyzeDesign (it never
      // enters the LLM prompt). Consumed once, then cleared.
      const attachedImage = pendingImageRef.current?.dataUrl;

      const requestBody = JSON.stringify({
        message: newUserMessage,
        sessionId: existingSessionId,
        ...(attachedImage ? { imageBase64: attachedImage } : {}),
        // customerId will be attached here once storefront auth lands (long-term memory key).
      });
      if (attachedImage) { setPendingImage(null); pendingImageRef.current = null; }

      // Try streaming first; on ANY failure fall back to the buffered endpoint
      // so the storefront keeps working exactly as before.
      let data: any;
      try {
        data = await streamChat(requestBody, newMessages, guardedSetMessages, cfgRef.current.projectId);
      } catch (streamErr) {
        console.warn('[chat] streaming failed, using buffered fallback:', streamErr);
        guardedSetMessages(newMessages); // clear any partial streamed text
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(cfgRef.current.projectId ? { 'X-Tenant-ID': cfgRef.current.projectId } : {}) },
          body: requestBody,
        });
        if (!res.ok) {
          const errorData = await res.json().catch(() => ({}));
          throw new Error(errorData.error || 'API Error');
        }
        data = await res.json();
      }

      if (data.sessionId && typeof window !== 'undefined') {
        localStorage.setItem(sKey, data.sessionId);
      }

      // A response for an abandoned thread must not touch messages or the
      // journey panel — the sessionId above is still written (it's keyed to
      // the OLD conversation's own storage slot, so that part is harmless and
      // correct), but nothing below this point may run for a stale turn.
      if (!isCurrent()) return;

      // Update messages to the full conversation history from the backend (including tool calls/responses)
      if (data.conversation && data.conversation.length > 0) {
        guardedSetMessages(data.conversation);
      } else {
        const aiText = data.message?.content || '';
        if (aiText) {
          const updatedMessages = [...newMessages, { role: 'assistant', content: aiText }];
          guardedSetMessages(updatedMessages);
        }
      }

      let hasPhaseChange = false;
      // Process UI actions from the backend
      if (data.uiActions && data.uiActions.length > 0) {
        for (const rawAction of data.uiActions) {
          /* Tool arguments arrive EITHER as a parsed object or as the raw JSON
           * string the model emitted, depending on how the turn streamed. Every
           * handler below reads properties off it, so an unparsed string makes
           * each one silently read `undefined` — the panel then keeps whatever
           * it was already showing while the agent describes something new.
           * Normalise once, here, rather than in eleven places. */
          const action = (() => {
            const a = rawAction?.arguments;
            if (typeof a !== 'string') return rawAction;
            try {
              return { ...rawAction, arguments: JSON.parse(a) };
            } catch {
              // Malformed arguments are worse than none: acting on half a tool
              // call is how the wrong garment gets shown.
              return { ...rawAction, arguments: {} };
            }
          })();

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
          } else if (action.name === 'researchSchool') {
            // Live brand research (AUG-48). arguments IS the server-side research
            // (colours mapped to our palette, sources, mascot). Shown for the
            // customer to confirm before anything renders.
            dispatch({ type: 'SET_SCHOOL_RESEARCH', research: action.arguments });
            hasPhaseChange = true;
          } else if (action.name === 'updateQuote') {
            // P0-04: arguments IS the authoritative server quote (lines + totals
            // computed server-side from the catalogue + tenant pricing). Store it
            // verbatim — the client never recomputes prices.
            dispatch({ type: 'SET_SERVER_QUOTE', quote: action.arguments });
            hasPhaseChange = true;
          } else if (action.name === 'showItems') {
            // Product recommendations — set them in state for ProductsPanel
            dispatch({
              type: 'SET_RECOMMENDED_PRODUCTS',
              products: action.arguments.products
            });
          } else if (action.name === 'showGuide') {
            // Troubleshooting or installation guide steps
            dispatch({
              type: 'SET_GUIDE_STEPS',
              steps: action.arguments.steps
            });
            hasPhaseChange = true;
          } else if (action.name === 'showAddons') {
            dispatch({ type: 'SET_ACCESSORIES', accessories: action.arguments.accessories || [] });
            hasPhaseChange = true;
          } else if (action.name === 'presentChoice') {
            dispatch({ type: 'SET_CHOICE', choice: { title: action.arguments.title, key: action.arguments.key, options: action.arguments.options || [] } });
            hasPhaseChange = true;
          } else if (action.name === 'showDocuments') {
            dispatch({ type: 'SET_INSTALL_GUIDE', installGuide: { productName: action.arguments.productName, summary: action.arguments.summary, guides: action.arguments.guides || [] } });
            hasPhaseChange = true;
          } else if (action.name === 'showInfo') {
            dispatch({ type: 'SET_WARRANTY', warranty: action.arguments });
            hasPhaseChange = true;
          } else if (action.name === 'showConfigurator') {
            /* Open the 3D configurator ALREADY showing what the customer described.
             * Merged, not replaced, so a follow-up like "make it maroon" changes
             * one facet and leaves the name, number and artwork intact. */
            const a = action.arguments || {};
            /* A NEW style is a new garment, not an edit of the old one. Merging
             * into the previous design left the panel rendering the last item
             * while the agent described the new one — the customer was told
             * they were looking at something they were not. */
            if (a.sku) dispatch({ type: 'CLEAR_DESIGN' });
            dispatch({ type: 'SET_DESIGN', design: {
              ...(a.sku ? { sku: String(a.sku) } : {}),
              ...(a.baseColor ? { baseColor: String(a.baseColor) } : {}),
              ...(a.accentColor ? { accentColor: String(a.accentColor) } : {}),
              // Without the design line the pattern layer never switches on and
              // the garment renders blank whatever the colours are.
              ...(a.designLine ? { designLine: String(a.designLine) } : {}),
              ...(a.textColour ? { textColour: String(a.textColour) } : {}),
              ...(a.outlineColour ? { outlineColour: String(a.outlineColour) } : {}),
              ...(a.name != null ? { name: String(a.name) } : {}),
              ...(a.number != null ? { number: String(a.number) } : {}),
              ...(a.note ? { note: String(a.note) } : {}),
            } });
            dispatch({ type: 'SET_PHASE', phase: 'configurator' });
            hasPhaseChange = true;
          } else if (action.name === 'showProof') {
            /* CDL Path A: the faithful proof — the customer's actual artwork
             * reproduced on our garment. This is the hero for artwork-heavy
             * uploads that colour zones can't represent. */
            if (action.arguments?.proofId) {
              dispatch({ type: 'SET_PROOF', proofId: String(action.arguments.proofId) });
              hasPhaseChange = true;
            }
          } else if (action.name === 'showConcept') {
            /* CDL Door A: the AI-generated concept image the customer asked us to
             * design. Stored separately from `design` so a following
             * showConfigurator (which CLEAR_DESIGNs for the matched real template)
             * doesn't wipe it — the concept stays pinned as "your concept". */
            if (action.arguments?.conceptId) {
              dispatch({ type: 'SET_CONCEPT', conceptId: String(action.arguments.conceptId) });
            }
          } else if (action.name === 'generateTeamDesign') {
            /* Coach team-order journey — up to four flat views (front/back/left/
             * right). Merge, never replace: a follow-up edit re-generates all four
             * but any view that failed this round should not wipe what is shown. */
            const a = action.arguments || {};
            dispatch({ type: 'SET_TEAM_DESIGN', teamDesign: {
              ...(a.frontId ? { frontId: String(a.frontId) } : {}),
              ...(a.backId ? { backId: String(a.backId) } : {}),
              ...(a.leftId ? { leftId: String(a.leftId) } : {}),
              ...(a.rightId ? { rightId: String(a.rightId) } : {}),
              ...(a.brief ? { brief: String(a.brief) } : {}),
              ...(a.sku ? { sku: String(a.sku) } : {}),
            } });
            // TeamRosterPanel/ConfiguratorPanel (teamPreview) price and render
            // against state.design.sku, same as the individual-shopper journey —
            // mirror the sku here so the roster step has a real style to price.
            if (a.sku) dispatch({ type: 'SET_DESIGN', design: { sku: String(a.sku) } });
            dispatch({ type: 'SET_PHASE', phase: 'teamDesign' });
            hasPhaseChange = true;
          } else if (action.name === 'uploadPhotosFor3D') {
            /* Real-photo 3D match — the tool's only job is to switch the UI into
             * "show me your 4 photos" mode; the actual bake happens client-side
             * in PhotoUploadDesignPanel once the customer submits. */
            const a = action.arguments || {};
            if (a.sku) dispatch({ type: 'SET_DESIGN', design: { sku: String(a.sku) } });
            dispatch({ type: 'SET_PHASE', phase: 'photoUploadDesign' });
            hasPhaseChange = true;
          } else if (action.name === 'recommendSize') {
            /* Fitment guide — arguments IS the server's recommendSize result
             * verbatim (a real recommendation grounded in a real size chart, or
             * an honest ok:false when we don't have one). Never recomputed
             * client-side. */
            dispatch({ type: 'SET_SIZE_RECOMMENDATION', sizeRecommendation: action.arguments });
            hasPhaseChange = true;
          } else if (action.name === 'buildProjectPlan') {
            /* PlaceMakers deterministic project & materials planner */
            dispatch({ type: 'SET_PROJECT_PLAN', projectPlan: action.arguments });
            dispatch({ type: 'SET_PHASE', phase: 'projectPlan' });
            hasPhaseChange = true;
          } else if (action.name === 'checkBranchStock') {
            /* PlaceMakers branch stock fulfillment lookup */
            dispatch({ type: 'SET_BRANCH_STOCK', branchStock: action.arguments });
          }
        }
        // If AI called updateQuote but forgot setPhase('quote'), do it
        if (!hasPhaseChange && data.uiActions.some((a: any) => a.name === 'updateQuote')) {
          dispatch({ type: 'SET_PHASE', phase: 'quote' });
          hasPhaseChange = true;
        }
        // If AI called showProducts but forgot setPhase('products'), do it
        if (!hasPhaseChange && data.uiActions.some((a: any) => a.name === 'showItems')) {
          dispatch({ type: 'SET_PHASE', phase: 'products' });
          hasPhaseChange = true;
        }
      }
      
      // Safety: if we're stuck on 'validating' and the AI didn't transition us
      if (!hasPhaseChange) {
        const latestState = stateRef.current;
        // Fallback to the most relevant phase based on what we have in state
        if (latestState.phase === 'configurator' && latestState.design?.sku) {
          /* Already designing a real garment and this turn only spoke — STAY put.
           * The chain below had no configurator branch, so any text-only reply
           * mid-design threw the customer back to an older phase (usually the
           * stale product list) while they were mid-edit. Leaving the phase
           * untouched is the only correct move: there is nothing newer to show. */
        } else if (latestState.customBom && latestState.customBom.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'quote' });
        } else if (latestState.guideSteps && latestState.guideSteps.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'guide' });
        } else if (latestState.recommendedProducts && latestState.recommendedProducts.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'products' });
        } else if (latestState.dynamicQuestions && latestState.dynamicQuestions.length > 0) {
          dispatch({ type: 'SET_PHASE', phase: 'clarify' });
        } else {
          dispatch({ type: 'SET_PHASE', phase: 'intro' });
        }
      }
      dispatch({ type: 'SET_THINKING', thinking: false });
    } catch (err: any) {
      console.error('Chat error:', err);
      if (isCurrent()) {
        setMessages(prev => [...prev, { role: 'assistant', content: `🚨 **Error:** ${err.message}` }]);
        dispatch({ type: 'SET_THINKING', thinking: false });
        dispatch({ type: 'SET_PHASE', phase: 'intro' }); // Reset phase on error
      }
    } finally {
      setIsLoading(false);
    }
  }, [dispatch]);

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
  // Generic bridge so the capability panels (accessories / choice / install /
  // warranty) can send a follow-up message to advance the journey.
  useEffect(() => {
    (window as any).__journeySend = (text: string) => append({ role: 'user', content: text });
    return () => { delete (window as any).__journeySend; };
  }, [append]);

  useEffect(() => {
    (window as any).__handleClarifySubmit = handleClarifySubmit;
    return () => { delete (window as any).__handleClarifySubmit; };
  }, [handleClarifySubmit]);

  // Called when user clicks "Build Quote" on ProductsPanel
  const handleBuildQuote = useCallback(async (summary?: string) => {
    /* Spell out WHAT to quote.
     *
     * The kit lives only in client state — the request carries just
     * { message, sessionId } — so an agent asked to "build the quote for the
     * items in my rack" cannot see the rack at all. It then guesses from the
     * conversation and describes a quote instead of building one, which is the
     * "nothing happens" the customer experiences. Send the actual style codes,
     * quantities and designs so there is nothing left to infer.
     *
     * Quantity comes from the team size the customer already gave, so a 14-player
     * order is quoted as 14, not 1. */
    const kit = stateRef.current.kit || [];
    const qty = stateRef.current.qty && stateRef.current.qty > 1 ? stateRef.current.qty : undefined;
    const kitLines = kit
      .filter((k) => k?.sku)
      .map((k) => {
        const bits = [k.title || k.name || k.sku, `SKU ${k.sku}`];
        if (k.designLine) bits.push(`${k.designLine} design`);
        const cols = [k.baseColor, k.accentColor].filter(Boolean).join(' / ');
        if (cols) bits.push(cols);
        if (qty) bits.push(`qty ${qty}`);
        return `- ${bits.join(', ')}`;
      });

    const content = summary
      || (kitLines.length
        ? `Build my quote for the items on my rack:\n${kitLines.join('\n')}\n`
          + `Please put these exact styles${qty ? ` at ${qty} each` : ''} on the quote.`
        : 'Build my quote with the recommended products');
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
    (window as any).__handleBuildQuote = handleBuildQuote;
    return () => { delete (window as any).__handleBuildQuote; };
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
    (window as any).__handleUserMessage = handleUserMessage;
    return () => { delete (window as any).__handleUserMessage; };
  }, [handleUserMessage]);


  const onSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    const hasImage = !!pendingImageRef.current;
    if (!prompt.trim() && !hasImage) return;
    // Image-only send: give the agent a clear opening so it runs analyzeDesign.
    const content = prompt.trim() || "Here's my design — can you make this?";
    append({ role: 'user', content });
    setPrompt('');
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  // Merge context messages (welcome) with chat messages.
  // Hide tool results and tool-call-only turns — they carry machine data
  // (e.g. {"success":true}) and must never render as chat bubbles.
  const allMessages = [...state.messages, ...messages
    .filter(m => m.role !== 'tool' && !m.tool_calls)
    .map((m, i) => ({
      id: `msg-${i}`,
      role: m.role as 'user' | 'ai' | 'note',
      text: m.content || ''
    }))]
    .filter(m => m.text)
    // Multi-tenant greeting: the welcome bubble shows the project's configured
    // greeting (persona.greetingMessage) when set.
    .map(m => (m.id === 'welcome' && cfg.greeting ? { ...m, text: cfg.greeting } : m));

  return (
    <div className="chat-panel" data-sidebar={cfg.theme?.sidebarStyle || 'light'}>
      {/* Header — the brand's own logo + name, and sign-in. Nothing else: the
          "Team Kit Builder / Augusta Team Outfitter" title+subtitle and the
          "Online" status badge were noise the customer didn't need. */}
      <div className="chat-header">
        <img
          className="chat-header__logo"
          src={cfg.theme?.logoUrl || (cfg.projectId === 'placemakers' ? '/brands/placemakers.svg' : '')}
          alt={cfg.companyName || 'Brand'}
          onError={(e) => {
            const img = e.target as HTMLImageElement;
            if (cfg.projectId === 'placemakers' && !img.src.endsWith('/brands/placemakers.svg')) {
              img.src = '/brands/placemakers.svg';
            } else {
              img.style.display = 'none';
            }
          }}
          style={{ maxHeight: '36px', width: 'auto', display: 'block' }}
        />
        {(!cfg.theme?.logoUrl && cfg.projectId !== 'placemakers') && (
          <div className="chat-header__brand">{cfg.companyName || 'JourneyAX'}</div>
        )}
        <div className="chat-header__actions">
          {/* View bag — persistent return path to the retail bag. Shown once the
              bag has items and we're not already on it; the complete-the-look
              step otherwise leaves the shopper with no way back to checkout. */}
          {isCart && bagCount > 0 && state.phase !== 'quote' && (
            <button
              type="button"
              className="chat-header__bag"
              onClick={() => dispatch({ type: 'SET_PHASE', phase: 'quote' })}
              title="View your bag"
              aria-label={`View your bag, ${bagCount} item${bagCount === 1 ? '' : 's'}`}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M6 8h12l-1 12H7L6 8Z" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
                <path d="M9 8V6a3 3 0 0 1 6 0v2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
              </svg>
              <span className="chat-header__bag-count">{bagCount}</span>
            </button>
          )}
          {/* Conversations. One customer has more than one job — this season's
              volleyball kit, next month's caps — and each deserves its own
              thread with its own context, plus a way back to the earlier one. */}
          <div className="chat-header__convos">
            <button
              type="button"
              className="chat-header__iconbtn"
              onClick={() => setConvoMenuOpen((o) => !o)}
              title="Your conversations"
              aria-label="Your conversations"
              aria-expanded={convoMenuOpen}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9 9 0 0 1-3.7-.8L3 21l1.9-4.8A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z"
                      stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </button>
            <button
              type="button"
              className="chat-header__iconbtn"
              onClick={startNewConversation}
              title="Start a new conversation"
              aria-label="Start a new conversation"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </button>
            {convoMenuOpen && (
              <div className="chat-header__convomenu" role="menu">
                <div className="chat-header__convomenu-title">Your conversations</div>
                {convos.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="menuitem"
                    className={`chat-header__convoitem${c.id === convoId ? ' is-active' : ''}`}
                    onClick={() => openConversation(c.id)}
                  >
                    <span className="chat-header__convoitem-title">{c.title}</span>
                    <span className="chat-header__convoitem-when">
                      {new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    </span>
                  </button>
                ))}
                <button type="button" role="menuitem" className="chat-header__convonew" onClick={startNewConversation}>
                  + New conversation
                </button>
              </div>
            )}
          </div>
          <button
            type="button"
            className="chat-header__signin"
            onClick={onSignIn}
            title={displayName ? `Signed in as ${displayName}` : 'Sign in'}
          >
            {displayName ? displayName.split(' ')[0] : 'Sign in'}
          </button>
        </div>
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
        {state.phase === 'intro' && messages.length === 0 && introStarters.length > 0 && (
          <div className="chat-suggestions">
            {introStarters.map((s, i) => (
              <div
                key={i}
                className="chat-suggestion"
                onClick={() => append({ role: 'user', content: s.prompt })}
              >
                <span className="chat-suggestion__arrow">→</span>
                {s.label}
              </div>
            ))}
          </div>
        )}
        {/* CDL: a design the customer attached, waiting to send with their next message. */}
        {pendingImage && (
          <div className="chat-attach-preview" style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '0 0 8px', padding: '6px 8px', borderRadius: 10, background: 'rgba(0,0,0,0.05)', border: '1px solid rgba(0,0,0,0.08)' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={pendingImage.dataUrl} alt="Attached design" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} />
            <span style={{ flex: 1, fontSize: 13, opacity: 0.8, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{pendingImage.name}</span>
            <button type="button" aria-label="Remove attached design" onClick={() => setPendingImage(null)} style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 16, lineHeight: 1, opacity: 0.6 }}>✕</button>
          </div>
        )}
        <form
          className="chat-input-row"
          onSubmit={onSubmit}
          onDrop={e => { e.preventDefault(); readImageFile(e.dataTransfer?.files?.[0]); }}
          onDragOver={e => e.preventDefault()}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={e => { readImageFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <button
            type="button"
            className="chat-attach-btn"
            aria-label="Attach a design image"
            title="Attach a design image"
            onClick={() => fileInputRef.current?.click()}
            style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', border: 'none', background: 'transparent', cursor: 'pointer', padding: 4, opacity: 0.65 }}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <path d="M21.44 11.05l-9.19 9.19a5 5 0 01-7.07-7.07l9.19-9.19a3 3 0 014.24 4.24l-9.19 9.19a1 1 0 01-1.41-1.41l8.48-8.49" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          <input
            className="chat-input"
            value={prompt}
            onChange={e => setPrompt(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={e => { const f = Array.from(e.clipboardData?.items || []).find(i => i.type.startsWith('image/'))?.getAsFile(); if (f) { e.preventDefault(); readImageFile(f); } }}
            placeholder={pendingImage ? 'Add a note, or just send your design…' : introPlaceholder}
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
