/**
 * Some models write "Now, I will look for their open cases." or "I am checking their account and will provide a summary as soon as I have
 * the verified details." and then stop without making the call. The loop treats a reply with no tool calls as the answer, so the turn would
 * end on a promise. This recognises that kind of reply.
 *
 * Every sentence is read, not only the last one, and each is one of four things: a PROMISE to do something with the tools (a step it
 * announces, a present-tense "I am checking", a "will be confirmed shortly", an "as soon as I have the figures"); a HAND-OFF, where a
 * person will act ("I'll let you know", "a team member will follow up"); a COURTESY line ("let me know if…", "is there anything else…?");
 * or CONTENT, which is anything else, including a question the assistant needs answered. The reply is a stall when it holds a promise and
 * nothing after the last promise is content: a promise followed by the actual answer is fine, a promise followed only by courtesy lines is
 * not. Nothing here knows a business word: the verbs are the assistant's own.
 */
const ACTION =
  '(?:look|check|find|search|fetch|get|pull|retrieve|list|call|review|see|run|query|open|read|try|use|dig|gather|compare|work out|calculate|add|confirm|verify|provide|update|share|give|send|prepare|summari[sz]e|put together|go ahead|proceed|access|collect|compile)';
const LEAD_IN =
  "(?:(?:now|next|then|first|okay|ok|alright|great|so|after that|once (?:i have|i've) [^,.;]*|when (?:i have|i've) [^,.;]*)[,:]?\\s+)?";
const INTENT = new RegExp(
  `^${LEAD_IN}(?:let me|let's|i will|i'll|i am going to|i'm going to|i am now going to|i'm now going to|i can now|i shall|i need to|i just need to)\\s+(?:now\\s+|then\\s+|also\\s+|just\\s+|quickly\\s+|first\\s+)?${ACTION}\\b`,
  'i',
);
/** Doing it right now, in words: "I am checking…", "I'm gathering…". */
const DOING = new RegExp(
  `^${LEAD_IN}(?:i am|i'm)\\s+(?:now\\s+|currently\\s+|just\\s+|still\\s+)?(?:checking|looking(?: into| up| at| for| through)?|gathering|pulling|retrieving|reviewing|searching|fetching|getting|confirming|verifying|calculating|working(?: on| out| through)?|querying|running|reading|preparing|finding|accessing|collecting|compiling|going through)\\b`,
  'i',
);
/** Something "will be confirmed shortly": a promise in the passive voice. */
const PASSIVE_SOON = /\bwill be (?:confirmed|provided|verified|checked|retrieved|updated|shared|sent|available|ready|with you)\b[^.]*\b(?:shortly|soon|in a moment|momentarily|as soon as)\b/i;
/** Asking for time instead of taking it. */
const MOMENT = /^(?:one moment|just a moment|just a second|bear with me|give me a (?:moment|second|minute)|hold on|hang on|please wait)\b/i;
/** Waiting on its own lookup: "as soon as I have the verified details", "once I have confirmed which account". */
const SELF_WAIT = /\b(?:as soon as|once|when|after) i (?:have|'ve|get|receive|can)\b(?! (?:spoken|heard|talked|a reply|a response|word|confirmation from|checked with|confirmed with))/i;
/** A person will act: not the assistant's own next step with the tools. */
const A_PERSON_WILL_ACT = /\b(let you know|get back to you|follow up|reach out|contact you|come back to you|be in touch)\b/i;
/** A line that only offers more: it carries no answer. */
const COURTESY = /^(?:if you|should you|let me know|please let me know|just let me know|feel free|happy to|i'm here|i am here|is there anything|anything else|would you like|do you (?:need|want)|shall i|can i help|could i help|want me to|hope (?:this|that) helps|thank(?:s| you))\b/i;
/** A question that only offers more ("Is there anything else…?"); any other question is content the assistant is waiting for. */
const OFFER_QUESTION = /^(?:is there anything|anything else|would you like|do you (?:need|want)|shall i|can i help|could i help|want me to|need anything|should i)\b/i;

type Kind = 'promise' | 'handoff' | 'courtesy' | 'content';

function kindOf(sentence: string): Kind {
  const clean = sentence.replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim();
  if (!clean) return 'courtesy';
  if (/\?\s*$/.test(clean)) return OFFER_QUESTION.test(clean) ? 'courtesy' : 'content';
  if (COURTESY.test(clean)) return 'courtesy';
  const selfWait = SELF_WAIT.test(clean);
  if (A_PERSON_WILL_ACT.test(clean) && !selfWait) return 'handoff';
  if (INTENT.test(clean) || DOING.test(clean) || PASSIVE_SOON.test(clean) || MOMENT.test(clean) || selfWait) return 'promise';
  return 'content';
}

/** True when the reply promises a next step with the tools and never delivers it: see the note at the top. */
export function announcesNextStep(text: string | undefined | null): boolean {
  const body = String(text ?? '').trim();
  if (!body) return false;
  const kinds = body
    .split(/(?<=[.!:…?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map(kindOf);
  const lastPromise = kinds.lastIndexOf('promise');
  if (lastPromise < 0) return false;
  return !kinds.slice(lastPromise + 1).includes('content');
}

export const STALL_NUDGE =
  'You said you would take another step, or that you were checking something. Take it now with the tools, in this step, and do not describe what you are about to do. If you already have everything you need, write the answer instead.';
