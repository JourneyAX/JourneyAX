import type { ClaimClass } from '@journeyax/knowledge';

export interface ClaimValidatorOptions {
  locale?: string;
  referrals?: Record<string, string[]> | string[];
  extraClaimPatterns?: Partial<Record<ClaimClass, (string | RegExp)[]>> | Record<string, Partial<Record<ClaimClass, (string | RegExp)[]>>>;
}

/** What is known about this turn, so a word that is part of a product's name is not mistaken for a claim. */
export interface ClaimContext {
  /** Product titles, brands and group names the tools returned this turn. */
  knownNames?: string[];
}

const CLAIM_PATTERNS: ReadonlyArray<[ClaimClass, RegExp]> = [
  ['warranty', /\b(?:warrant(?:y|ies|ed)|guarantee(?:d|s)?|covered for \d+)\b/i],
  ['legal_requirement', /\b(?:compli(?:ant|ance|es|ed|y)|building code|regulat(?:ion|ory)|legally|by law|certified to)\b/i],
  // "compatible with …" and "is compatible" say a product works with something; "you may need a compatible battery" only names what to look for.
  ['compatibility', /\b(?:compatib(?:le|ility)\s+(?:with|between|across)|(?:is|are|isn[’']t|aren[’']t|be|being|fully|also|largely|generally|not|100%)\s+(?:an?\s+)?compatible|compatibility|fits? (?:with|every|all|the)|works? with|suitable for)\b/i],
  ['substitution', /\b(?:equivalent|substitut(?:e|ion)|interchangeable|replacement for)\b/i],
  // An installation step is something a person is told to DO: an install, or a verb with what it is done to. A bare "drill" or "wire" is as
  // often a product ("cordless drill", "wire wardrobe") and a bare "mounting bracket" a product name, so the verb must be doing something.
  ['installation_step', /\b(?:install(?:ed|ing|ation|s)?|mount(?:ed|ing|s)?\s+(?:\w+\s+){0,3}?(?:to|on|onto|into|with|using|at)|attach(?:ed|ing|es)?\s+(?:\w+\s+){0,3}?(?:to|onto|with|using)|drill(?:ed|ing|s)?\s+(?:\w+\s+){0,2}?(?:into|through|a\s+(?:\d+\s*mm\s+)?(?:pilot\s+)?holes?|holes|pilot)|wire[sd]?\s+(?:\w+\s+){0,2}?(?:to|into|up)\b|wiring\s+(?:to|into|up)|fix(?:ing|ed|es)?\s+(?:\w+\s+){0,3}?to|connect(?:ed|ing|s)?\s+(?:\w+\s+){0,3}?to|fasten(?:ed|s)?\s+(?:\w+\s+){0,3}?(?:to|with|using|down|every)|fastening\s+(?:to|with|into|down))\b/i],
  ['care_safety', /\b(?:dilut(?:e|es|ed|ing|ion)|abrasive|chemical|ventilat(?:e|es|ed|ing|ion)|clean(?:er|ing)? safely)\b/i],
  [
    'safety_instruction',
    /\b(?:safe to|unsafe|hazard|danger|isolat(?:e|es|ing) (?:the |your |it |them )?\w+|(?:turn|switch|shut)(?: \w+){0,3}? off|(?:avoid|stop) using|(?:do not|don't|never) use|protective equipment|(?:wear|use) (?:\w+ ){0,2}(?:respirators?|masks?|gloves|goggles|glasses|protective))\b/i,
  ],
  // "need to" is a requirement only when it says what the product or the job takes ("you need to use treated timber"); "you need to check", "an area you
  // need to cover" are the customer's own to-do and say nothing about the product.
  ['requirement', /\b(?:must|mandatory|required|requires?|necessary|need(?:s)? to (?:be|use|have|get|fit|apply|wear|follow|comply|obtain|replace|seal|fix))\b/i],
  ['catalog_fact', /(?:\$\s?\d|\bsku\s*[:#]|\b(?:costs?\s+\d|price(?:d)? at)\b)/i],
  ['stock', /\b(?:in stock|out of stock|in-stock|out-of-stock|available now)\b/i],
];

export function extractReferralPatterns(options?: ClaimValidatorOptions | any): RegExp[] {
  if (!options) return [];
  const referrals =
    options.referrals ||
    options.conversationPolicy?.referrals ||
    options.profile?.referrals ||
    options.extensions?.claimGuard?.referrals ||
    options.pack?.conversationPolicy?.referrals;

  if (!referrals) return [];

  let list: string[] = [];
  if (Array.isArray(referrals)) {
    list = referrals;
  } else if (typeof referrals === 'object') {
    const locale = options.locale || options.profile?.primaryLocale || 'en-NZ';
    const lang = locale.split('-')[0];
    list = referrals[locale] || referrals[lang] || referrals['default'] || referrals['*'] || [];
  }

  return list.map((item) => {
    if (item.startsWith('/') && item.lastIndexOf('/') > 0) {
      const lastSlash = item.lastIndexOf('/');
      const body = item.slice(1, lastSlash);
      const flags = item.slice(lastSlash + 1);
      return new RegExp(body, flags || 'i');
    }
    const escaped = item.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    return new RegExp(`\\b${escaped}\\b`, 'i');
  });
}

export function extractExtraClaimPatterns(options?: ClaimValidatorOptions | any): ReadonlyArray<[ClaimClass, RegExp]> {
  if (!options) return [];
  const extra =
    options.extraClaimPatterns ||
    options.conversationPolicy?.extraClaimPatterns ||
    options.profile?.extraClaimPatterns ||
    options.extensions?.claimGuard?.extraClaimPatterns ||
    options.pack?.conversationPolicy?.extraClaimPatterns;

  if (!extra || typeof extra !== 'object') return [];

  const result: Array<[ClaimClass, RegExp]> = [];
  for (const [claimClass, patterns] of Object.entries(extra)) {
    if (!Array.isArray(patterns)) continue;
    for (const pat of patterns) {
      if (typeof pat === 'string') {
        const regex = pat.includes('\\b') ? new RegExp(pat, 'i') : new RegExp(`\\b${pat}\\b`, 'i');
        result.push([claimClass as ClaimClass, regex]);
      } else if (pat instanceof RegExp) {
        result.push([claimClass as ClaimClass, pat]);
      }
    }
  }
  return result;
}

function isIntroductoryTopicPhrase(clause: string): boolean {
  const trimmed = clause.trim();
  if (!/^(?:for|regarding|as for|in case of|with respect to|when considering)\b/i.test(trimmed)) {
    return false;
  }
  if (/\b(?:is|are|has|have|was|were|must|should|requires?|install|drill|mount|wire|fasten|fits?|suitable|use|apply)\b/i.test(trimmed)) {
    return false;
  }
  return true;
}

function checkClauseForClaims(
  trimmed: string,
  allowed: Set<ClaimClass>,
  referralPatterns: RegExp[],
  claimPatterns: ReadonlyArray<[ClaimClass, RegExp]>
): ClaimClass[] {
  if (!trimmed || trimmed.endsWith('?')) return [];

  const matchingPattern = referralPatterns.find((pattern) => pattern.test(trimmed));

  if (!matchingPattern) {
    const forbidden: ClaimClass[] = [];
    for (const [claim, pattern] of claimPatterns) {
      if (!allowed.has(claim) && pattern.test(trimmed)) {
        forbidden.push(claim);
      }
    }
    return forbidden;
  }

  // A referral may exempt ONLY the referral clause.
  // Split the sentence and still check the remaining part.
  const match = matchingPattern.exec(trimmed);
  if (!match) return [];

  const matchStart = match.index;
  const matchEnd = matchStart + match[0].length;

  const beforeMatch = trimmed.slice(0, matchStart);
  const boundaryBefore = beforeMatch.search(/(?:[,;:—–]|\b(?:and|but|yet|so)\b)[^,;:—–]*$/i);

  const afterMatch = trimmed.slice(matchEnd);
  const boundaryAfter = afterMatch.search(/[,;:—–]|\b(?:and|but|yet|so)\b/i);

  const partBefore = trimmed.slice(0, boundaryBefore !== -1 ? boundaryBefore : 0).trim();
  const partAfter = (
    boundaryAfter !== -1
      ? afterMatch.slice(boundaryAfter).replace(/^[,;:—–\s]+|\b(?:and|but|yet|so)\b\s*/i, '')
      : ''
  ).trim();

  const remainingParts: string[] = [];

  if (partBefore) {
    const isTopicIntro =
      /^(?:for|regarding|as for|in case of|with respect to|when considering)\b/i.test(partBefore) &&
      !/\b(?:is|are|has|have|was|were|must|should|requires?|install|drill|mount|wire|fasten|fits?|suitable|use|apply)\b/i.test(
        partBefore
      );

    if (!isTopicIntro) {
      remainingParts.push(partBefore);
    }
  }

  if (partAfter) {
    const isTopicAfter =
      /^(?:for|regarding|as for|in case of|with respect to|when considering)\b/i.test(partAfter) &&
      !/\b(?:is|are|has|have|was|were|must|should|requires?|install|drill|mount|wire|fasten|fits?|suitable|use|apply)\b/i.test(
        partAfter
      );

    if (!isTopicAfter) {
      remainingParts.push(partAfter);
    }
  }

  if (remainingParts.length === 0) {
    return [];
  }

  const forbidden: ClaimClass[] = [];
  for (const part of remainingParts) {
    for (const [claim, pattern] of claimPatterns) {
      if (!allowed.has(claim) && pattern.test(part)) {
        if (!forbidden.includes(claim)) {
          forbidden.push(claim);
        }
      }
    }
  }

  return forbidden;
}

// ── What a sentence is doing ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// The patterns above spot words. A word alone cannot tell "install the bracket at 300mm centres" (a claim) from "I couldn't confirm an
// installation guide" (the opposite of a claim), "tell me how much area you need to cover" (a request), "please speak to a licensed
// builder about compliance" (a referral) or "if you can confirm it is suitable" (a condition). A clause that states none of the
// claim classes is not judged by the words in it.

/** Splits a sentence where the speaker turns to a new statement ("…, but …", "…; …", "… — …"). */
const CLAUSE_BREAK = /\s*(?:,\s*)?\b(?:but|however|although|though|yet|except|while|so)\b\s+|\s*;\s*|\s+[—–]\s+/i;

/** Says what is NOT known or NOT found: the honest answer the assistant is told to give. */
const DISCLAIMER = /\b(?:(?:could not|couldn[’']t|can[’']?t|cannot|unable to|not able to|wasn[’']t able to|haven[’']t been able to)\s+(?:\w+\s+){0,2}?(?:confirm|verify|find|see|say|tell|check|state|establish|rule out)|(?:don[’']t|do not|doesn[’']t|does not|didn[’']t|did not|hasn[’']t|has not)\s+(?:\w+\s+){0,2}?(?:have|show|say|state|confirm|mention|list|specify|include|return|give|carry|come with)|not (?:been )?(?:confirmed|verified|stated|specified|listed|shown|returned|checked)|no (?:installation |warranty |care )?(?:guide|details|information|record|note|literature) (?:was |were |is |are )?(?:found|on file|available|returned|listed)|I(?:[’']m| am) not sure)\b/i;

/** A request to the customer, or an invitation to answer, written as a statement ("tell me…", "a few choices will help sort…"). */
const REQUEST_START = /^(?:please\b|tell me\b|let me know\b|just (?:tell|let|pick|answer)\b|pick\b|choose\b|answer\b|send me\b|(?:to|so that i can) (?:narrow|point|help|find|make sure|get|work out|give|recommend)\b[^.]{0,100}?\b(?:i (?:just |first |still )?need|tell me|let me know)\b|i (?:just |first |still )?need to (?:know|ask|narrow|check|confirm|find out|understand|see)\b|a few (?:quick )?(?:choices|questions|details|answers|things)\b[^.]{0,80}\bwill help\b)/i;

/** Sends the customer to check or ask someone: a referral or a "check this" suggestion. */
const DIRECTIVE = /\b(?:please (?:check|confirm|speak|talk|ask|contact|see|consult|refer)|(?:also |first )?check (?:that |the |whether |with |if |you[’']ve|it |they )|(?:speak|talk|chat|check|confirm|consult|ask|contact) (?:with |to )?(?:your |our |a |an |the )?(?:\w+ ){0,3}?(?:builder|surveyor|LBP|licensed|qualified|professional|engineer|electrician|gasfitter|council|team|branch|manufacturer|specialist|staff|installer|plumber|supplier|documentation|documents)|it[’']?s worth (?:checking|confirming|asking|speaking|double-checking)|(?:should|best to|worth) (?:confirm|check|verify)|you (?:may|might|will|[’']ll) (?:want|need) to (?:check|confirm|ask|speak|measure))\b/i;

/** Opens a condition: "if you can confirm it is suitable…", "whether it needs to handle…". */
const CONDITIONAL_CLAUSE = /^(?:if|whether|unless|in case|when)\b/i;

/** Words that make a statement a claim whatever else it says: an obligation, the law, a guarantee, a length of time. */
const HARD_CLAIM = /\b(?:must|mandatory|required|legally|by law|guarantee[ds]?|certified to)\b|\b\d+[- ]?(?:years?|yrs?|months?)\b/i;

/**
 * A condition is not an assertion: "if you can confirm it is suitable…", "whether it needs to handle vehicles", "balustrade if required".
 * The condition is set aside and what is said around it is still judged: "If it is near the coast, it must be stainless" keeps its "must".
 */
function withoutConditions(clause: string): string {
  let rest = clause;
  if (CONDITIONAL_CLAUSE.test(rest)) {
    const comma = rest.indexOf(',');
    if (comma === -1) return '';
    rest = rest.slice(comma + 1).trim();
  }
  return rest
    .replace(/\b(?:if|where|when|whenever|as|should it be)\s+(?:be\s+)?(?:required|necessary|needed|mandatory)\b/gi, ' ')
    .replace(/\b(?:if|unless|whether|in case)\b[^,;]*/gi, ' ')
    .trim();
}

/** A verb of having or being: what turns a bare list of things into a statement about one of them. */
const ASSERTING_VERB = /\b(?:is|are|was|were|has|have|had|comes?|includes?|carr(?:y|ies)|gives?|meets?|offers?)\b|\bneeds?\s+to\s+(?:be|use|have|get|fit|apply|wear|follow|comply|obtain|replace|seal|fix)\b/i;

/** Does anything joined on after the opening ("…and the paint has a lifetime warranty") state something of its own? */
function joinedStatement(rest: string): boolean {
  return rest.split(/\b(?:and|also|plus|then)\b/i).slice(1).some((part) => {
    const stated = withoutConditions(part.trim());
    return HARD_CLAIM.test(stated) || ASSERTING_VERB.test(stated);
  });
}

/**
 * True when a clause states nothing the claim classes are about: a request, an honest "could not confirm", or a pointer to someone to
 * ask. A statement joined on after that opening ("we couldn't find the guide and it must be installed by a licensed builder") still
 * counts, so an opening that asserts nothing cannot carry a claim through behind it.
 */
function assertsNothing(clause: string): boolean {
  if (!clause) return true;
  for (const opening of [REQUEST_START, DISCLAIMER]) {
    const found = opening.exec(clause);
    if (found) return !joinedStatement(clause.slice(found.index + found[0].length));
  }
  const directive = DIRECTIVE.exec(clause);
  if (directive) return !HARD_CLAIM.test(clause) && !joinedStatement(clause.slice(directive.index + directive[0].length));
  return false;
}

const nameMatchers = new WeakMap<string[], RegExp | null>();

/** The names of this turn's products and groups as one pattern, longest first. */
function namePattern(names: string[] | undefined): RegExp | null {
  if (!names || names.length === 0) return null;
  if (nameMatchers.has(names)) return nameMatchers.get(names)!;
  const cleaned = [...new Set(names.map((name) => String(name || '').replace(/\s+/g, ' ').trim()).filter((name) => name.length >= 4))]
    .sort((a, b) => b.length - a.length)
    .slice(0, 400)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+'));
  const pattern = cleaned.length ? new RegExp(`(?<![\\w])(?:${cleaned.join('|')})s?(?![\\w])`, 'gi') : null;
  nameMatchers.set(names, pattern);
  return pattern;
}

/** A product's own name is not a claim about it: "Mounting Bracket 90mm" names a thing, it does not tell anyone to mount anything. */
function withoutKnownNames(clause: string, context?: ClaimContext): string {
  const pattern = namePattern(context?.knownNames);
  return pattern ? clause.replace(pattern, ' ◼ ') : clause;
}

function checkSentenceForClaims(
  trimmed: string,
  allowed: Set<ClaimClass>,
  referralPatterns: RegExp[],
  claimPatterns: ReadonlyArray<[ClaimClass, RegExp]>,
  context?: ClaimContext
): ClaimClass[] {
  if (!trimmed || trimmed.endsWith('?')) return [];
  const forbidden: ClaimClass[] = [];
  for (const rawClause of trimmed.split(CLAUSE_BREAK).map((part) => part.trim()).filter(Boolean)) {
    const stated = withoutConditions(rawClause);
    if (assertsNothing(stated)) continue;
    const clause = withoutKnownNames(stated, context);
    for (const claim of checkClauseForClaims(clause, allowed, referralPatterns, claimPatterns)) {
      if (!forbidden.includes(claim)) forbidden.push(claim);
    }
  }
  return forbidden;
}

/**
 * Deterministic fail-closed check for regulated and transactional claim forms.
 * Questions do not assert a claim. This lexical check is only a final guard;
 * model text is still sourced from the pinned release and live capabilities.
 */
export function validateOkfGeneratedClaims(
  text: string,
  allowedClasses: ClaimClass[],
  options?: ClaimValidatorOptions | any,
  context?: ClaimContext
): {
  valid: boolean;
  forbidden: ClaimClass[];
} {
  const allowed = new Set(allowedClasses);
  const forbidden = new Set<ClaimClass>();
  const referralPatterns = extractReferralPatterns(options);
  const extraPatterns = extractExtraClaimPatterns(options);
  const claimPatterns = extraPatterns.length > 0 ? [...CLAIM_PATTERNS, ...extraPatterns] : CLAIM_PATTERNS;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.endsWith('?')) continue;
    const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, claimPatterns, context);
    for (const c of sentenceForbidden) forbidden.add(c);
  }
  return { valid: forbidden.size === 0, forbidden: [...forbidden] };
}

export interface WithheldSentence {
  sentence: string;
  classes: ClaimClass[];
}

/**
 * The same check, applied one sentence at a time. A reply that makes one unsupported claim keeps its other sentences, because a single
 * ordinary word ("fastening timber" in a product description) should not cost the customer the whole answer; the sentences that do
 * assert a claim class the release does not allow are removed, never rewritten. A reply that is nothing but such sentences comes back
 * empty and the caller says so in the tenant's own wording.
 */
export function withholdUnsupportedClaims(
  text: string,
  allowedClasses: ClaimClass[],
  options?: ClaimValidatorOptions | any,
  context?: ClaimContext
): { text: string; removed: WithheldSentence[] } {
  const allowed = new Set(allowedClasses);
  const removed: WithheldSentence[] = [];
  const referralPatterns = extractReferralPatterns(options);
  const extraPatterns = extractExtraClaimPatterns(options);
  const claimPatterns = extraPatterns.length > 0 ? [...CLAIM_PATTERNS, ...extraPatterns] : CLAIM_PATTERNS;

  const lines = text
    .split(/\n+/)
    .map((line) => {
      const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
        const trimmed = sentence.trim();
        if (!trimmed) return false;
        if (trimmed.endsWith('?')) return true;
        const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, claimPatterns, context);
        if (sentenceForbidden.length === 0) return true;
        removed.push({ sentence: trimmed, classes: sentenceForbidden });
        return false;
      });
      return kept.join(' ').trim();
    })
    .filter(Boolean);

  return { text: lines.join('\n'), removed };
}

