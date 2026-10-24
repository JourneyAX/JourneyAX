/**
 * What the chat request can carry today. The turn endpoint (`/api/chat/stream` → commerce service → runtime) accepts no agent
 * id: the runtime's agent router picks the agent for each message from the pack. Until that changes, the composer's agent chip
 * is read-only (it names the agent that answered, or the default one) and "Try" on an agent only starts a fresh chat.
 *
 * When the runtime starts honouring an `agentId` on the turn request, flip this to true: the chip becomes a picker and the
 * chosen id is sent with each turn (ChatPanel adds `agentId` to the request body only when this is true).
 */
export const CHAT_REQUEST_ACCEPTS_AGENT_ID = false;
