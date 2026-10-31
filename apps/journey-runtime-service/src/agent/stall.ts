/**
 * Some models write "Now, I will look for their open cases." or "I am checking their account and will provide a summary as soon as I have
 * the verified details." and then stop without making the call. The loop treats a reply with no tool calls as the answer, so the turn would
 * end on a promise. This recognises that kind of reply.
 *
 * Every sentence is read, not only the last one, and each is one of five things: a PROMISE to do something with the tools (a step it
 * announces, a present-tense "I am checking", a "will be confirmed shortly", an "as soon as I have the figures"); a HAND-OFF, where a
 * person will act ("I'll let you know", "a team member will follow up", "confirmed by the branch"); an ASK, where the assistant waits on the
 * person (a question that needs an answer, "once you tell me which account"); a COURTESY or filler line ("let me know if…", "this may take
 * a few seconds"); or CONTENT, which is anything else. The reply is a stall when it holds a promise, nothing after the last promise is
 * content, and the reply does not ask the person for anything: a promise followed by the actual answer is fine, and a promise that waits on
 * the person's answer is not a stall. Nothing here knows a business word: the verbs are the assistant's own.
 */
const ACTION =
  '(?:look|check|find|search|fetch|get|pull|retrieve|list|call|review|see|run|query|open|read|try|use|dig|gather|compare|work out|calculate|add|confirm|verify|provide|update|share|give|send|prepare|summari[sz]e|put together|go ahead|proceed|access|collect|compile|take a look|have a look|look into|investigate|dig into|work on|start|begin)';
const ING =
  '(?:checking|looking(?: into| up| at| for| through)?|gathering|pulling(?: up)?|retrieving|reviewing|searching|fetching|getting|confirming|verifying|calculating|working(?: on| out| through)?|querying|running|preparing|finding|accessing|collecting|compiling|going through|putting together|investigating|digging into|taking a look)';
const LEAD_IN =
  "(?:(?:sure|of course|certainly|absolutely|thanks|thank you|got it|understood|no problem|great|okay|ok|alright|right|so|now|next up|next|then|first|after that|to [^,.;]{1,70}|once (?:i have|i've) [^,.;]*|when (?:i have|i've) [^,.;]*)[,:]?\\s+)*";
const SUBJECT =
  "(?:let me|let's|let us|i will|i'll|i shall|i am going to|i'm going to|i am just going to|i'm just going to|i am now going to|i'm now going to|i can now|i am about to|i'm about to|i will need to|i'll need to|i am going to need to|i'm going to need to|i will have to|i'll have to|i need to|i just need to)";
const ADVERB = '(?:(?:now|then|also|just|quickly|first|go ahead and|go and|start by|begin by|proceed to)\\s+)*';
const INTENT = new RegExp(`^${LEAD_IN}${SUBJECT}\\s+${ADVERB}${ACTION}\\b`, 'i');
/** "I will be checking…": the future progressive. */
const WILL_BE = new RegExp(`^${LEAD_IN}(?:i will be|i'll be)\\s+${ING}\\b`, 'i');
/** Doing it right now, in words: "I am checking…", "I'm gathering…". "I'm finding no open cases" is a result, not a promise. */
const DOING = new RegExp(`^${LEAD_IN}(?:i am|i'm)\\s+(?:now\\s+|currently\\s+|just\\s+|still\\s+)?${ING}\\b(?! no\\b| nothing\\b| that\\b)`, 'i');
/** A progress line with no subject: "Checking the ERP now.", "Looking into it now." */
const BARE = new RegExp(`^${ING}\\b`, 'i');
/** Something "will be confirmed shortly": a promise in the passive voice. */
const PASSIVE_SOON = /\bwill be (?:confirmed|provided|verified|checked|retrieved|updated|shared|sent|available|ready|with you)\b[^.]*\b(?:shortly|soon|in a moment|momentarily|as soon as)\b/i;
/** Asking for time instead of taking it. */
const MOMENT = /^(?:one moment|just a moment|just a (?:sec|second)|one sec|bear with me|give me a (?:moment|second|minute)|hold on(?: a (?:moment|sec|second|minute))?(?:[.,!]|$| while)|hang on(?: a (?:moment|sec))?(?:[.,!]|$| while)|hang tight|please hold(?:[.,!]|$)|please wait(?:[.,!]|$| while)|i'm on it|i am on it|on it(?:[.,!]|$))/i;
/** The assistant waiting on its own lookup: "as soon as I have the verified details", "once I have confirmed which account, I will…". */
const SELF_WAIT = /\bas soon as i (?:have|'ve|get|receive|can)\b(?! (?:spoken|heard|talked|a reply|a response|word|confirmation from|checked with|confirmed with))|\bonce i (?:have|'ve|get|receive)\b[^.]*\b(?:i will|i'll|i can)\b|\bget back to you with (?:the|a|an|your)\b|\b(?:i'll|i will) be right back\b|\bbe right back with\b/i;
/** Waiting on someone else: a third party's answer, or a thing a team does. */
const THIRD_PARTY = /\b(?:from|with) (?:them|the (?:branch|team|warehouse|supplier|depot|store|desk))\b|\btheir (?:answer|reply|response)\b|\bby (?:the |our )?(?:[a-z]+ )?(?:team|branch|desk|department|depot|finance|dispatch|accounts|sales|manager|rep|warehouse|treasury)\b|\b(?:checking|confirming|speaking|talking|following up|chasing) with (?:the|our|a|their)\b/i;
/** A person will act: not the assistant's own next step with the tools. */
const A_PERSON_WILL_ACT = /\b(let you know|get back to you|follow up|reach out|contact you|come back to you|be in touch)\b/i;
/** Conditional on the person: "once you tell me which account", "if you like", "on request". */
const CONDITIONAL_ON_PERSON = /\b(?:if|when|once|after|as soon as|before|unless|until)\s+(?:you|the (?:customer|person|colleague))\b|\bif you(?:'d)? (?:like|want|need|prefer)\b|\b(?:on|upon) request\b|\bif (?:needed|required|wanted)\b/i;
/** The assistant needs something from the person. */
const ASKS_PERSON = /^(?:please (?:send|tell|confirm|provide|share|give|let me know)|can you|could you|would you (?:mind|please)|which (?:one|of|account|branch|order|product)\b|i need (?:to (?:know|see|confirm which)|you to)\b|i need the \w+ (?:number|name|id|code)\b)|\bwhich (?:one|of the \w+(?: \w+)?|account|branch)\b[^.]*\byou mean\b/i;
/** A line that only offers more or fills time: it carries no answer. */
const COURTESY = /^(?:if you|should you|let me know|please let me know|just let me know|feel free|happy to|i'm here|i am here|is there anything|anything else|would you like|do you (?:need|want)|shall i|can i help|could i help|want me to|hope (?:this|that) helps|thank(?:s| you))\b/i;
const FILLER = /^(?:this (?:may|might|will|should) take|please bear with me|bear with me|stay tuned|i'll be right with you|i will be right with you|thanks for (?:your )?patience|thank you for (?:your )?patience|it won'?t take long|this won'?t take long|almost there|in the meantime)\b/i;
/** A question that only offers more ("Is there anything else…?"); a question that picks between options is an ask. */
const OFFER_QUESTION = /^(?:is there anything|anything else|would you like|do you (?:need|want)|shall i|can i help|could i help|want me to|need anything|should i)\b/i;

/** Questions that only offer more, whatever else they say. */
const ALWAYS_OFFER = /^(?:is there anything|anything else|can i help|could i help|need anything)\b/i;

type Kind = 'promise' | 'handoff' | 'ask' | 'courtesy' | 'content';

/** Typographic apostrophes and quotes written the plain way, so "I’m checking" reads like "I'm checking". */
const plain = (text: string): string => text.replace(/[‘’ʼ]/g, "'").replace(/[“”]/g, '"');

function kindOf(sentence: string): Kind {
  const clean = plain(sentence).replace(/^[-*•]\s+/, '').replace(/\*\*/g, '').trim();
  if (!clean) return 'courtesy';
  if (/\?\s*$/.test(clean)) {
    if (ALWAYS_OFFER.test(clean)) return 'courtesy';
    if (OFFER_QUESTION.test(clean) && !(/\bor\b/i.test(clean) && !/\b(?:such as|for example|e\.g\.)/i.test(clean)) && !/\bwhich\b/i.test(clean)) return 'courtesy';
    return 'ask';
  }
  if (ASKS_PERSON.test(clean)) return 'ask';
  if (CONDITIONAL_ON_PERSON.test(clean)) return 'courtesy';
  if ((INTENT.test(clean) || WILL_BE.test(clean) || DOING.test(clean)) && !THIRD_PARTY.test(clean) && !(A_PERSON_WILL_ACT.test(clean) && !SELF_WAIT.test(clean) && !INTENT.test(clean) && !DOING.test(clean))) return 'promise';
  if (COURTESY.test(clean) || FILLER.test(clean)) return 'courtesy';
  const promise = INTENT.test(clean) || WILL_BE.test(clean) || DOING.test(clean) || BARE.test(clean) || PASSIVE_SOON.test(clean) || MOMENT.test(clean) || SELF_WAIT.test(clean);
  // A third party's answer or a team's action is a hand-off, even where the sentence also reads like a wait.
  if (THIRD_PARTY.test(clean)) return 'handoff';
  if (promise) return A_PERSON_WILL_ACT.test(clean) && !SELF_WAIT.test(clean) && !INTENT.test(clean) && !DOING.test(clean) ? 'handoff' : 'promise';
  if (A_PERSON_WILL_ACT.test(clean)) return 'handoff';
  return 'content';
}

/** True when the reply promises a next step with the tools and never delivers it: see the note at the top. */
export function announcesNextStep(text: string | undefined | null): boolean {
  const body = String(text ?? '').trim();
  if (!body) return false;
  const kinds = plain(body)
    .split(/(?<=[.!:…?])\s+|\n+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .map(kindOf);
  const lastPromise = kinds.lastIndexOf('promise');
  if (lastPromise < 0) return false;
  // A reply that waits on the person's answer is not a stall, whatever else it says.
  if (kinds.includes('ask')) return false;
  return !kinds.slice(lastPromise + 1).includes('content');
}

export const STALL_NUDGE =
  'You said you would take another step, or that you were checking something. Take it now with the tools, in this step, and do not describe what you are about to do. If you already have everything you need, write the answer instead.';
