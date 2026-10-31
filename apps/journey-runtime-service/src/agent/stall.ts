/**
 * Some models write "Now, I will look for their open cases." and then stop without making the call. The loop treats a reply with no tool calls as
 * the answer, so the turn would end on a promise. This recognises that kind of ending: the last sentence says, in the first person, that the
 * assistant is about to do something with its tools. It is not a hand-off to a person ("I'll let you know", "a team member will follow up") and it
 * is not a question to the user.
 */
const ACTION = '(?:look|check|find|search|fetch|get|pull|retrieve|list|call|review|see|run|query|open|read|try|use|dig|gather|compare|work out|calculate|add)';
const INTENT = new RegExp(`^(?:(?:now|next|then|first|okay|ok|alright|great|so)[,:]?\\s+)?(?:let me|let's|i will|i'll|i am going to|i'm going to|i can now|i shall)\\s+(?:now\\s+|then\\s+|also\\s+|just\\s+|quickly\\s+)?${ACTION}\\b`, 'i');
const A_PERSON_WILL_ACT = /\b(let you know|get back to you|follow up|reach out|contact you|come back to you|be in touch)\b/i;

export function announcesNextStep(text: string | undefined | null): boolean {
  const body = String(text ?? '').trim();
  if (!body || /\?\s*$/.test(body)) return false;
  const sentences = body.split(/(?<=[.!:…])\s+|\n+/).map((sentence) => sentence.trim()).filter(Boolean);
  const last = sentences[sentences.length - 1] ?? '';
  return INTENT.test(last) && !A_PERSON_WILL_ACT.test(last);
}

export const STALL_NUDGE = 'You said you would take another step. Take it now with the tools. If you already have everything you need, write the answer instead.';
