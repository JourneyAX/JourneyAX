/**
 * What the chat request can carry. The turn endpoint (`/api/chat/stream` → commerce service → runtime) accepts an `agentId`:
 * the runtime's agent router answers with that agent when the tenant's pack defines it, and ignores any other id. So the
 * composer's agent chip is a picker, the chosen id is sent with each turn, and "Try" on an agent starts a chat with it.
 *
 * Set this to false to fall back to the older behaviour (the router chooses for each message, the chip only names who answered).
 */
export const CHAT_REQUEST_ACCEPTS_AGENT_ID = true;
