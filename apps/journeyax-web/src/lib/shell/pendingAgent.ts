/**
 * "Try" on an agent in Customize starts a chat with that agent: the id is kept for the moment between the two pages and taken
 * (once) by the chat when it opens. Storage failures are harmless: the chat then simply starts with the default agent.
 */
const KEY = 'jx.pendingAgent';

export function setPendingAgent(agentId: string | undefined): void {
  try {
    if (agentId) window.sessionStorage.setItem(KEY, agentId); else window.sessionStorage.removeItem(KEY);
  } catch { /* storage may be blocked */ }
}

/** The agent waiting for the chat, removed so a later visit does not repeat it. */
export function takePendingAgent(): string {
  try {
    const value = window.sessionStorage.getItem(KEY) || '';
    window.sessionStorage.removeItem(KEY);
    return value;
  } catch { return ''; }
}
