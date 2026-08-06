/**
 * Conversations in the storefront.
 *
 * The chat used to keep exactly one session id per project, forever. Every
 * visit resumed the same thread, so a customer who had just priced volleyball
 * jerseys and came back to ask about baseball caps carried the whole previous
 * brief with them — and there was no way to put it down. Two separate jobs need
 * two separate threads.
 *
 * Each conversation owns its own server session, so switching threads switches
 * the agent's memory with it. Everything here is per project: one browser used
 * for two storefronts never mixes their threads.
 */

export interface Conversation {
  id: string;
  title: string;
  updatedAt: number;
}

const ns = (projectId?: string) => projectId || 'default';

export const listKey = (projectId?: string) => `jx_convos::${ns(projectId)}`;
export const activeKey = (projectId?: string) => `jx_active_convo::${ns(projectId)}`;
export const messagesKey = (projectId: string | undefined, convoId: string) =>
  `jx_messages::${ns(projectId)}::${convoId}`;
export const sessionKey = (projectId: string | undefined, convoId: string) =>
  `jx_session_id::${ns(projectId)}::${convoId}`;
/** AUG-89: the 60% panel's journey state (phase, products, quote, design…),
 *  snapshotted per conversation so reopening a thread replays its journey
 *  instead of resetting to the intro hero. Keyed like messages/session. */
export const journeyKey = (projectId: string | undefined, convoId: string) =>
  `jx_journey::${ns(projectId)}::${convoId}`;

/** Legacy single-thread keys, kept only so an in-progress chat survives the upgrade. */
const legacyMessagesKey = (projectId?: string) => `jx_messages::${ns(projectId)}`;
const legacySessionKey = (projectId?: string) => `jx_session_id::${ns(projectId)}`;

const MAX_CONVERSATIONS = 20;

function read<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: unknown): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota — best effort */
  }
}

export function newId(): string {
  return `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function listConversations(projectId?: string): Conversation[] {
  return read<Conversation[]>(listKey(projectId), []).sort((a, b) => b.updatedAt - a.updatedAt);
}

export function saveConversations(projectId: string | undefined, list: Conversation[]): void {
  // Oldest threads fall off rather than filling storage forever; their messages
  // go with them so nothing is orphaned.
  const kept = [...list].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_CONVERSATIONS);
  if (typeof window !== 'undefined') {
    const keptIds = new Set(kept.map((c) => c.id));
    for (const c of list) {
      if (keptIds.has(c.id)) continue;
      try {
        localStorage.removeItem(messagesKey(projectId, c.id));
        localStorage.removeItem(sessionKey(projectId, c.id));
      } catch { /* best effort */ }
    }
  }
  write(listKey(projectId), kept);
}

/**
 * The conversation to open on load, creating one if this is a first visit.
 *
 * A chat already in progress under the old single-thread keys is adopted as the
 * first conversation — an upgrade must never look like lost work.
 */
export function resolveActiveConversation(projectId?: string): { id: string; list: Conversation[] } {
  let list = listConversations(projectId);

  if (!list.length && typeof window !== 'undefined') {
    const legacyMessages = localStorage.getItem(legacyMessagesKey(projectId));
    const id = newId();
    if (legacyMessages) {
      localStorage.setItem(messagesKey(projectId, id), legacyMessages);
      const legacySession = localStorage.getItem(legacySessionKey(projectId));
      if (legacySession) localStorage.setItem(sessionKey(projectId, id), legacySession);
      localStorage.removeItem(legacyMessagesKey(projectId));
      localStorage.removeItem(legacySessionKey(projectId));
    }
    list = [{ id, title: titleFrom(legacyMessages), updatedAt: Date.now() }];
    saveConversations(projectId, list);
    write(activeKey(projectId), id);
    return { id, list };
  }

  const stored = read<string>(activeKey(projectId), '');
  const active = list.find((c) => c.id === stored) || list[0];
  if (active) return { id: active.id, list };

  const id = newId();
  const created = [{ id, title: 'New conversation', updatedAt: Date.now() }];
  saveConversations(projectId, created);
  write(activeKey(projectId), id);
  return { id, list: created };
}

export function setActiveConversation(projectId: string | undefined, id: string): void {
  write(activeKey(projectId), id);
}

/**
 * The server session backing the conversation currently on screen.
 *
 * Anything outside the chat that needs to reach the agent's memory — pricing a
 * kit against the roster size, for one — must go through here rather than
 * rebuild a storage key by hand, which is how a team order silently became a
 * quantity of one.
 */
export function activeSessionId(projectId?: string): string | undefined {
  if (typeof window === 'undefined') return undefined;
  const id = read<string>(activeKey(projectId), '');
  if (!id) return undefined;
  return localStorage.getItem(sessionKey(projectId, id)) || undefined;
}

/** Name a thread after what the customer actually asked for. */
export function titleFrom(messagesJson: string | null | undefined): string {
  if (!messagesJson) return 'New conversation';
  try {
    const parsed = JSON.parse(messagesJson);
    const first = Array.isArray(parsed) ? parsed.find((m: any) => m?.role === 'user')?.content : '';
    return summarise(first);
  } catch {
    return 'New conversation';
  }
}

export function summarise(text?: string): string {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (!t) return 'New conversation';
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}
