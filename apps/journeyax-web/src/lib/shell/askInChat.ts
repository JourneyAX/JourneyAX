/**
 * Puts a question to the assistant on the person's behalf, from somewhere that is not the message box (a row on the dashboard, a line on a
 * card). The chat registers how it takes a question; if it is in the middle of an answer, the question is typed into the box instead of being
 * sent, so nothing is lost and nothing is sent on top of a reply that is still being written.
 */
export type AskHandler = (text: string) => boolean;

let handler: AskHandler | null = null;

/** The chat says how it takes a question; returns what to call to stop. */
export function registerAskHandler(next: AskHandler): () => void {
  handler = next;
  return () => { if (handler === next) handler = null; };
}

/** Asks in the chat. Returns false when nothing is listening or the question is empty. */
export function askInChat(text: string): boolean {
  const clean = text.replace(/\s+/g, ' ').trim().slice(0, 600);
  if (!clean || !handler) return false;
  return handler(clean);
}
