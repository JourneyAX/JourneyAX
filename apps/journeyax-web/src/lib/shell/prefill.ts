/**
 * A question put in the message box of the next new chat: "Try in chat" on the Customize page starts a chat with the question already typed
 * (not sent), so the person only has to read it and press send. Kept for this browser tab only, and used once.
 */
const key = (projectId: string | undefined) => `jx_prefill_${projectId || 'default'}`;

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const defaultStore = (): Store | undefined => { try { return typeof window === 'undefined' ? undefined : window.sessionStorage; } catch { return undefined; } };

export function setPrefill(projectId: string | undefined, text: string, store: Store | undefined = defaultStore()): boolean {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!store || !clean) return false;
  try { store.setItem(key(projectId), clean); return true; } catch { return false; }
}

/** The waiting question, and it is gone after this. */
export function takePrefill(projectId: string | undefined, store: Store | undefined = defaultStore()): string {
  if (!store) return '';
  try {
    const text = store.getItem(key(projectId)) || '';
    if (text) store.removeItem(key(projectId));
    return text;
  } catch { return ''; }
}
