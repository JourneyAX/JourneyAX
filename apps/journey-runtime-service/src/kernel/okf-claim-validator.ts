import type { ClaimClass } from '@journeyax/knowledge';
import claimGuardDefaults from '../defaults/claim-guard.json';
import { numericValues } from './numeric-evidence';
import { isCatalogueAbsenceStatement } from '@journeyax/shared-types';

export interface ClaimValidatorOptions {
  locale?: string;
  referrals?: Record<string, string[]> | string[];
  extraClaimPatterns?: Partial<Record<ClaimClass, (string | RegExp)[]>> | Record<string, Partial<Record<ClaimClass, (string | RegExp)[]>>>;
}

/** What is known about this turn, so a word that is part of a product's name is not mistaken for a claim. */
export interface ClaimContext {
  /** Exact identifiers whose completed catalogue lookup returned no match. */
  catalogueMisses?: ReadonlySet<string>;
  catalogueWarrantyFacts?: readonly CatalogueWarrantyFact[];
  /** Exact source-owned fact statements/quotations, not model or browser assertions. */
  exactClaimStatements?: ReadonlyMap<ClaimClass, ReadonlySet<string>>;
  /** Customer/source-backed numerical values, never model-authored card state. */
  knownNumbers?: ReadonlySet<string>;
  /** Product titles, brands and group names the tools returned this turn. */
  knownNames?: string[];
  /** The titles and brands among them: a sentence about one of these specific products is not general know-how. */
  productNames?: string[];
}

export interface CatalogueWarrantyFact { sku: string; title: string; duration: string }

/** Only a sourced catalogue PERIOD may be paraphrased. Coverage, guarantees and exclusions need their own evidence. */
function isCatalogueWarrantyPeriod(text: string, facts: readonly CatalogueWarrantyFact[] | undefined): boolean {
  if (!facts?.length || !/\b(?:catalogue|catalog|listing|record|specifications?)\b/i.test(text)) return false;
  if (/\b(?:guarantee[ds]?|covers?|coverage|against|defects?|damage|labou?r|parts|exclusions?|lifetime|unlimited|refund|replacement|repairs?|transferable|workmanship)\b/i.test(text)) return false;
  const periods = [...text.matchAll(/\b(\d+(?:\.\d+)?)\s*[-‑–]?\s*(years?|months?|days?)\b/gi)];
  if (periods.length !== 1) return false;
  const value = Number(periods[0][1]); const unit = periods[0][2].toLowerCase().replace(/s$/, '');
  return facts.some(fact => {
    const source = fact.duration.match(/^(\d+(?:\.\d+)?)\s+(years?|months?|days?)$/i);
    if (!source || Number(source[1]) !== value || source[2].toLowerCase().replace(/s$/, '') !== unit) return false;
    const namedSkus = [...text.matchAll(/\bSKU\s*[:#]?\s*([A-Za-z0-9_-]+)/gi)]
      // "for this SKU: 5 years" names a period, not a different SKU called "5".
      .filter(match => !/^\s*(?:years?|months?|days?)\b/i.test(text.slice((match.index || 0) + match[0].length)))
      .map(match => match[1]);
    if (namedSkus.some(sku => sku.toLowerCase() !== fact.sku.toLowerCase())) return false;
    const others = facts.filter(other => other.sku !== fact.sku);
    if (others.some(other => text.toLowerCase().includes(other.sku.toLowerCase()))) return false;
    return facts.length === 1 || text.toLowerCase().includes(fact.sku.toLowerCase()) || (fact.title.length > 8 && text.toLowerCase().includes(fact.title.toLowerCase()));
  });
}

const CLAIM_PATTERNS: ReadonlyArray<[ClaimClass, RegExp]> = [
  ['warranty', /\b(?:warrant(?:y|ies|ed)|guarantee(?:d|s)?|covered for \d+)\b/i],
  ['legal_requirement', /\b(?:compli(?:ant|ance|es|ed|y)|building code|regulat(?:ion|ory)|legally|by law|certified to)\b/i],
  // "compatible with …" and "is compatible" say a product works with something; "you may need a compatible battery" only names what to look for.
  ['compatibility', /\b(?:compatib(?:le|ility)\s+(?:with|between|across)|(?:is|are|isn[’']t|aren[’']t|be|being|fully|also|largely|generally|not|100%)\s+(?:an?\s+)?compatible|compatibility|fits? (?:with|every|all|the)|works? with|suitable for)\b/i],
  ['compatibility', /\b(?:fits?\s+(?:(?:comfortably|easily|perfectly|neatly)\s+)?(?:your|this|inside|into|within|along|on\s+your|in\s+your)|will\s+fit\b|(?:a|the)\s+(?:perfect|ideal)\s+fit\b)/i],
  ['substitution', /\b(?:equivalent|substitut(?:e|ion)|interchangeable|replacement for)\b/i],
  // An installation step is something a person is told to DO: an install, or a verb with what it is done to. A bare "drill" or "wire" is as
  // often a product ("cordless drill", "wire wardrobe") and a bare "mounting bracket" a product name, so the verb must be doing something.
  ['installation_step', /\b(?:install(?:ed|ing|ation|s)?|mount(?:ed|ing|s)?\s+(?:\w+\s+){0,3}?(?:to|on|onto|into|with|using|at)|attach(?:ed|ing|es)?\s+(?:\w+\s+){0,3}?(?:to|onto|with|using)|(?<!\b(?:for|when|while|of)\s)drill(?:ed|ing|s)?\s+(?:\w+\s+){0,2}?(?:into|through|a\s+(?:\d+\s*mm\s+)?(?:pilot\s+)?holes?|holes|pilot)|wire[sd]?\s+(?:\w+\s+){0,2}?(?:to|into|up)\b|wiring\s+(?:to|into|up)|fix(?:ing|ed|es)?\s+(?:\w+\s+){0,3}?to|connect(?:ed|ing|s)?\s+(?:\w+\s+){0,3}?to|fasten(?:ed|s)?\s+(?:\w+\s+){0,3}?(?:to|with|using|down|every)|fastening\s+(?:to|with|into|down))\b/i],
  // Quantitative procedural advice is still an instruction when written as a
  // "rule of thumb" or an allocation, without an imperative installation verb.
  // No tenant, product family or journey participates in this classification.
  ['installation_step', /\b(?:rule of thumb|(?:minimum|maximum|recommended|required)\s+(?:spacing|clearance|embedment|dilution|overlap))\b[^\n.!?]{0,120}(?:\d|[≈=])/i],
  ['installation_step', /\b(?:use|allow|apply|plan|position|space|leave)\b[^\n.!?]{0,100}\b\d+(?:[.,]\d+)?\s+[^\n.!?]{0,35}\b(?:per|for every)\b/i],
  ['requirement', /\b(?:use|choose|go for|specify)\b[^\n.!?]{0,60}\bclass\s+\d/i],
  ['care_safety', /\b(?:dilut(?:e|es|ed|ing|ion)|abrasive|chemical|ventilat(?:e|es|ed|ing|ion)|clean(?:er|ing)? safely)\b/i],
  [
    'safety_instruction',
    /\b(?:safe to|unsafe|hazard|danger|isolat(?:e|es|ing) (?:the |your |it |them )?\w+|(?:turn|switch|shut)(?: \w+){0,3}? off|(?:avoid|stop) using|(?:do not|don't|never) use|protective equipment|(?:wear|use) (?:\w+ ){0,2}(?:respirators?|masks?|gloves|goggles|glasses|protective))\b/i,
  ],
  // Re-energising equipment or restoring a supply is a safety instruction too.
  // Requiring evidence only for turning it OFF left the opposite advice unchecked.
  ['safety_instruction', /\b(?:unplug(?:ging)?|disconnect(?:ing)?\s+(?:\w+\s+){0,3}(?:power|electricity|supply)|(?:turn|switch|shut)(?:\s+\w+){0,4}?\s+(?:back\s+)?on|re-?energiz(?:e|ing))\b/i],
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

/** The classes a pack may let through when the sentence is hedged general know-how. Warranty, legal, price, stock, safety and care are never among them. */
const HEDGEABLE_CLASSES: ReadonlySet<ClaimClass> = new Set<ClaimClass>(['installation_step', 'requirement', 'compatibility']);

export interface HedgedKnowHow {
  classes: ReadonlySet<ClaimClass>;
  hedge: RegExp;
}

/** The pack's hedged-know-how setting (`conversationPolicy.claimPolicy.hedgedKnowHow`), or nothing when it is off, which is the default. */
export function extractHedgedKnowHow(options?: ClaimValidatorOptions | any): HedgedKnowHow | undefined {
  if (!options) return undefined;
  const setting =
    options.claimPolicy?.hedgedKnowHow ||
    options.conversationPolicy?.claimPolicy?.hedgedKnowHow ||
    options.pack?.conversationPolicy?.claimPolicy?.hedgedKnowHow;
  if (!setting || setting.enabled !== true) return undefined;
  const classes = new Set<ClaimClass>(
    (Array.isArray(setting.classes) && setting.classes.length > 0 ? setting.classes : [...HEDGEABLE_CLASSES]).filter((claim: ClaimClass) => HEDGEABLE_CLASSES.has(claim)),
  );
  if (classes.size === 0) return undefined;
  let words: unknown = setting.hedgeWords;
  if (words && !Array.isArray(words) && typeof words === 'object') {
    const locale = String(options.locale || options.profile?.primaryLocale || 'en-NZ');
    const record = words as Record<string, string[]>;
    words = record[locale] || record[locale.split('-')[0]] || record['default'] || record['*'];
  }
  const list = (Array.isArray(words) && words.length > 0 ? words : claimGuardDefaults.hedgedKnowHow.hedgeWords).filter((word): word is string => typeof word === 'string' && word.trim().length > 0);
  const body = list.map((word) => word.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+')).join('|');
  return { classes, hedge: new RegExp(`\\b(?:${body})\\b`, 'i') };
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

/** An offer to retrieve information does not assert that information. Embedded product promises still go through the normal checks. */
function isInformationOffer(clause: string): boolean {
  return /^(?:if you (?:need|want)(?: more)? (?:details?|information|help)|let me know (?:what|whether|if)|i can (?:check|look up|find|retrieve)|would you like (?:me to|more|details|information))/i.test(clause.trim()) &&
    !/\b(?:is|are|has|have|comes?|guarantee[ds]?|covers?|covered|must|should|complies?|certified|fits?|suitable|compatible|use|apply|install|drill|lifetime|includ(?:es|ed))\b|\d/i.test(clause);
}

function checkClauseForClaims(
  trimmed: string,
  allowed: Set<ClaimClass>,
  referralPatterns: RegExp[],
  claimPatterns: ReadonlyArray<[ClaimClass, RegExp]>
): ClaimClass[] {
  if (!trimmed || isInformationOffer(trimmed)) return [];

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
const DISCLAIMER = /\b(?:(?:could not|couldn[’']t|can[’']?t|cannot|unable to|not able to|wasn[’']t able to|haven[’']t been able to)\s+(?:\w+\s+){0,2}?(?:confirm|verify|find|see|say|tell|check|state|establish|rule out)|(?:don[’']t|do not|doesn[’']t|does not|didn[’']t|did not|hasn[’']t|has not)\s+(?:\w+\s+){0,2}?(?:have|show|say|state|confirm|mention|list|specify|include|return|give|carry|come with)|(?:not|hasn[’']t|has not|haven[’']t|have not|wasn[’']t|was not|isn[’']t|is not|aren[’']t|are not|weren[’']t|yet to)\s+(?:yet\s+)?(?:been\s+|be\s+)?(?:confirmed|verified|stated|specified|listed|shown|returned|checked|looked up)|no (?:detailed |written |manufacturer |product-specific )*(?:installation |warranty |care )?(?:or guarantee )?(?:guide|details|information|record|note|literature|terms|certificate) (?:was |were |is |are )?(?:found|on file|available|returned|listed)|I(?:[’']m| am) not sure)\b/i;

/** A request to the customer, or an invitation to answer, written as a statement ("tell me…", "a few choices will help sort…"). */
const REQUEST_START = /^(?:please\b|tell me\b|let me know\b|just (?:tell|let|pick|answer)\b|pick\b|choose\b|answer\b|send me\b|(?:to|so that i can) (?:narrow|point|help|find|make sure|get|work out|give|recommend)\b[^.]{0,100}?\b(?:i (?:just |first |still )?need|tell me|let me know)\b|i (?:just |first |still )?need to (?:know|ask|narrow|check|confirm|find out|understand|see)\b|a few (?:quick )?(?:choices|questions|details|answers|things)\b[^.]{0,80}\bwill help\b)/i;

/** Sends the customer to check or ask someone: a referral or a "check this" suggestion. */
const DIRECTIVE = /\b(?:please (?:check|confirm|speak|talk|ask|contact|see|consult|refer)|(?:also |first )?check (?:that |the |whether |with |if |you[’']ve|it |they )|(?:speak|talk|chat|check|confirm|consult|ask|contact) (?:with |to )?(?:your |our |a |an |the )?(?:\w+ ){0,3}?(?:builder|surveyor|LBP|licensed|qualified|professional|engineer|electrician|gasfitter|council|team|branch|manufacturer|specialist|staff|installer|plumber|supplier|documentation|documents)|(?:checked|confirmed|signed off|reviewed|assessed|approved|verified|decided|specified)\s+by\s+(?:an?\s+|your\s+|our\s+|the\s+)?(?:\w+\s+){0,3}?(?:builder|surveyor|LBP|licensed|qualified|professional|engineer|electrician|gasfitter|council|team|branch|manufacturer|specialist|staff|installer|plumber|supplier)|(?:should|needs? to|ought to)\s+be\s+(?:checked|confirmed|verified|read|reviewed|double-checked)|it[’']?s worth (?:checking|confirming|asking|speaking|double-checking)|(?:should|best to|worth) (?:confirm|check|verify)|you (?:may|might|will|[’']ll) (?:want|need) to (?:check|confirm|ask|speak|measure))\b/i;

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
    .replace(/\b(?:saying|say|tell(?:ing)?|know(?:ing)?|check(?:ing)?|confirm(?:ing)?|sure|see(?:ing)?|show(?:ing)?)\s+(?:you\s+|me\s+)?(?:what|which|how many|how much)\b[^,;]*/gi, ' ')
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

/** Recognise only a bounded statement about missing evidence. The rest of the
 * clause is still checked, including quoted promises and joined assertions.
 * "No warranty" is a product-coverage claim and deliberately is not a match. */
function warrantyEvidenceLimitation(clause: string): { safe: boolean; joinedPromise: boolean } {
  const qualifier = '(?:(?:full|written|detailed|verified|confirmed|complete|separate|linked|specific|product-specific|manufacturer(?:[’\u0027]s)?)\\s+)*';
  const topic = '(?:warranty|guarantee)(?:\\s*(?:/|and|or)\\s*(?:warranty|guarantee))?';
  const evidence = '(?:terms(?:\\s*/\\s*conditions)?|details|information|documentation|documents?|guides?|certificates?|coverage\\s+details)';
  const patterns = [
    // "I have no verified information on the warranty terms ..."
    new RegExp(`\\bno\\s+${qualifier}(?:information|details|documentation)\\s+(?:on|about|regarding|for)\\s+(?:(?:the|this|that|its)\\s+)?${qualifier}${topic}(?:\\s+(?:${evidence}|coverage|period|conditions|exclusions))?\\b`, 'gi'),
    // "No verified warranty information ..." Only the evidence noun is negated.
    new RegExp(`\\bno\\s+${qualifier}${topic}\\s+${evidence}\\b(?:\\s+(?:was|were|is|are|has\\s+been|have\\s+been)\\s+(?:found|returned|provided|recorded|extracted|attached|available|on\\s+file))?`, 'gi'),
    // "The full written guarantee terms are not available ..."
    new RegExp(`\\b${qualifier}${topic}\\s+${evidence}\\s+(?:is|are|was|were|has\\s+been|have\\s+been)\\s+(?:(?:currently|yet|still)\\s+)?(?:not\\s+(?:available|provided|found|verified|confirmed|recorded|listed|attached|on\\s+file)|unavailable|missing)\\b`, 'gi'),
  ];
  let rest = clause;
  for (const pattern of patterns) rest = rest.replace(pattern, ' ');
  if (rest === clause) return { safe: false, joinedPromise: false };
  rest = rest.replace(/^(?:[-*•]\s*)?(?:(?:i|we)\s+(?:currently\s+)?(?:have|hold|found|received)|there\s+(?:is|are))\s*/i, '').trim();
  // Only the evidence limitation may be exempted. In particular "no terms,
  // and it covers damage" still asserts coverage even without another occurrence
  // of the word warranty; quotations and other-product promises count too.
  const promise = /\b(?:warrant(?:y|ies|ed)|guarantee[ds]?|covers?|covered|coverage\s+against|lifetime|unlimited|forever|replacement|refund|repairs?|defects?|workmanship|transferable|entitles?|protects?|excludes?|for\s+life)\b|\b\d+[- ]?(?:years?|yrs?|months?)\b/i.test(rest) || /\bcoverage\b/i.test(rest.replace(/\([^)]*\)/g, ' '));
  return { joinedPromise: promise, safe: !promise && !HARD_CLAIM.test(rest) && !ASSERTING_VERB.test(rest) && !/\b(?:against|includ(?:ed|es)|appl(?:ies|y))\b/i.test(rest) };
}

/**
 * True when a clause states nothing the claim classes are about: a request, an honest "could not confirm", or a pointer to someone to
 * ask. A statement joined on after that opening ("we couldn't find the guide and it must be installed by a licensed builder") still
 * counts, so an opening that asserts nothing cannot carry a claim through behind it.
 */
function assertsNothing(clause: string): boolean {
  if (!clause) return true;
  // Metadata lists may contain an abbreviation's full stop. It must not split
  // "terms (...) are not on file" into a supposed guarantee claim.
  const limitation = clause.replace(/\((?:(?:coverage(?: details)?|conditions|exclusions|claim process|installation requirements|what[’']s included\/excluded|etc\.)[\s,;/]*)+\)/gi, ' ');
  // A list of unavailable evidence followed by "cannot be confirmed" is still
  // a limitation. The anchored form cannot carry a positive promise after it.
  if (/^(?:[-*•]\s*)?(?:coverage (?:specifics|details)|installation (?:requirements|details)|warranty (?:terms|details)|guarantee (?:terms|details))\s+(?:cannot|can[’']t|could not)\s+be\s+(?:confirmed|verified)(?:\s+(?:here|from (?:these|the) (?:records|sources|documents)))?[.!]?$/i.test(limitation.replace(/[*_`]/g, '').trim())) return true;
  const documentMetadata = /\b(?:indexed|listed|classified|recorded) as (?:an? )?(?:instruction\s*\/\s*)?(?:installation|specification|technical)(?:\s*\/\s*technical)?(?: type)? (?:document|guide)\b/i.exec(clause);
  if (documentMetadata && !HARD_CLAIM.test(clause) && !joinedStatement(clause.slice(documentMetadata.index + documentMetadata[0].length))) return true;
  const noTerms = /\bno\s+(?:attached |detailed |separate |written |linked |product-specific |specific )*(?:warranty\s*(?:\/\s*guarantee\s*)?|guarantee\s*)?(?:terms|document|certificate|guide)\b[^.!?]{0,60}\b(?:extracted|found|on file|to quote)\b/i.exec(clause);
  if (noTerms && !HARD_CLAIM.test(clause.replace(/\bguarantee(?= (?:terms|document|certificate))/gi, '')) && !/\b(?:lifetime|unlimited|covers?|covered|guaranteed|\d+[- ]?(?:years?|months?))\b/i.test(clause) && !joinedStatement(clause.slice(noTerms.index + noTerms[0].length))) return true;
  const absentTerms = /^(?:[-*•]\s*)?no\s+(?:detailed |separate |written |linked |product-specific )*(?:warranty\s*(?:\/\s*guarantee\s*)?|guarantee\s*)?(?:terms|document|certificate|guide)(?:\s*\([^)]*\))?\s+(?:is|are)\s+(?:attached|available|on file|listed|recorded)\b/i.exec(clause);
  if (absentTerms && !joinedStatement(clause.slice(absentTerms[0].length)) && !/\b(?:lifetime|unlimited|covers?|covered|guaranteed|\d+[- ]?(?:years?|months?))\b/i.test(clause)) return true;
  // Missing source documents/terms are an evidence limitation, not a product promise.
  // Reject joined promises and numerical/obligatory claims even after an absence statement.
  if (!HARD_CLAIM.test(clause.replace(/\bguarantee(?= (?:terms|document|certificate))/gi, '')) && !/\b(?:lifetime|unlimited|covers?|covered|guaranteed)\b/i.test(clause) && !joinedStatement(clause) && (
    /\bno\s+(?:separate |detailed |written |linked |product-specific )*(?:breakdown|pdf|document|guide|terms|certificate)\b/i.test(clause) ||
    /\b(?:terms|coverage details|component breakdown|warranty document|guarantee document|installation guide)\b[^.!?]{0,80}\b(?:not available|not on file|not attached|not specified|missing|unavailable)\b/i.test(limitation)
  )) return true;
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
  const named = pattern ? clause.replace(pattern, ' ◼ ') : clause;
  // A unit conversion label is not a claim that two products are interchangeable.
  // The numerical evidence check still applies to the original sentence.
  return named.replace(/\b(?:metric|length|unit|dimensional) equivalen(?:t|ce)s?\b/gi, 'measurement conversion');
}

function checkSentenceForClaims(
  trimmed: string,
  allowed: Set<ClaimClass>,
  referralPatterns: RegExp[],
  claimPatterns: ReadonlyArray<[ClaimClass, RegExp]>,
  context?: ClaimContext,
  hedgedKnowHow?: HedgedKnowHow
): ClaimClass[] {
  if (!trimmed || isInformationOffer(trimmed)) return [];
  // A completed negative lookup is evidence too. Permit only the scoped absence
  // statement, never a price, stock promise or a second assertion appended to it.
  if (isCatalogueAbsenceStatement(trimmed, context?.catalogueMisses)) return [];
  // A topic heading promises no period or coverage. Substantive/lifetime claims are not headings.
  const topicLabel = trimmed.replace(/^(?:#{1,6}\s*|[-*•]\s*|\d+[.)]\s*)+/g, '').replace(/[*_:]/g, '').trim();
  if (/\b(?:warranty|guarantee)\b/i.test(topicLabel) && /^(?:(?:catalogue|catalog|manufacturer|product|written|full|detailed|warranty|guarantee|duration|period|terms|documents?|guides?|pdfs?|or|similar|and)\b|[\s/(&)–-])+$/i.test(topicLabel)) return [];
  if (/^(?:#{1,6}\s*)?(?:\d+[.)]\s*)?[*_]*(?:(?:catalogue |manufacturer |product )?warranty(?: duration| period| terms)?(?:\s*\/\s*guarantee(?: terms)?)?|guarantee(?:\s*\/\s*full terms|\s*\/\s*warranty terms| terms)?)[*_]*:?$/i.test(trimmed)) return [];
  const forbidden: ClaimClass[] = [];
  if (context?.knownNumbers && numericValues(trimmed).some(value => !context.knownNumbers!.has(value))) forbidden.push('catalog_fact');
  // A joined clause can omit the word "warranty" while still asserting what
  // that product covers. Missing terms do not authorise that embedded promise.
  if (!allowed.has('warranty') && /\b(?:warranty|guarantee)\b/i.test(trimmed) && trimmed.split(CLAUSE_BREAK).some(part => /\b(?:it|(?:this|the) (?:product|item))\s+(?:also\s+)?(?:covers|is covered)\b/i.test(withoutConditions(part)))) forbidden.push('warranty');
  for (const rawClause of trimmed.split(CLAUSE_BREAK).map((part) => part.trim()).filter(Boolean)) {
    const stated = withoutConditions(rawClause);
    const warrantyLimitation = warrantyEvidenceLimitation(stated);
    if (warrantyLimitation.joinedPromise && !allowed.has('warranty') && !forbidden.includes('warranty')) forbidden.push('warranty');
    if (!warrantyLimitation.joinedPromise && assertsNothing(stated)) continue;
    const clause = withoutKnownNames(stated, context).replace(/\b(this|that)\s+SKU\s*[:#]/gi, '$1 item:');
    // Hedged general know-how ("you'll generally want…"), when the pack allows it: only for the classes it names, and never a clause that
    // says "must", "required", "by law" or a length of time. A compatibility claim about a named product still needs its source.
    const hedgedPass = hedgedKnowHow && !HARD_CLAIM.test(clause) && hedgedKnowHow.hedge.test(clause);
    const productPattern = hedgedPass ? namePattern(context?.productNames) : null;
    const aboutAProduct = Boolean(productPattern && stated.search(productPattern) >= 0);
    for (const claim of checkClauseForClaims(clause, allowed, referralPatterns, claimPatterns)) {
      if (claim === 'warranty' && warrantyLimitation.safe) continue;
      if (hedgedPass && hedgedKnowHow.classes.has(claim) && !(claim === 'compatibility' && aboutAProduct)) continue;
      if (!forbidden.includes(claim)) forbidden.push(claim);
    }
  }
  return forbidden.filter(claim => !(claim === 'warranty' && isCatalogueWarrantyPeriod(trimmed, context?.catalogueWarrantyFacts)) && ![...(context?.exactClaimStatements?.get(claim) ?? [])].some(source => normalizeClaimStatement(source) === normalizeClaimStatement(trimmed)));
}

/** Formatting may change; the factual text may not. Extra coverage/conditions must fail. */
export function normalizeClaimStatement(text: string): string {
  return text.replace(/^\s*(?:[-*•>]\s*|\d+[.)]\s+)/, '').replace(/[*_`]/g, '').replace(/^\s*source (?:statement|excerpt|quotation)\s*:\s*/i, '').replace(/^["“]+|["”]+$/g, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Deterministic fail-closed check for regulated and transactional claim forms.
 * Question punctuation cannot exempt an embedded claim. This lexical check is only a final guard;
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
  const hedgedKnowHow = extractHedgedKnowHow(options);
  const extraPatterns = extractExtraClaimPatterns(options);
  const claimPatterns = extraPatterns.length > 0 ? [...CLAIM_PATTERNS, ...extraPatterns] : CLAIM_PATTERNS;

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;
    const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, claimPatterns, context, hedgedKnowHow);
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
  const hedgedKnowHow = extractHedgedKnowHow(options);
  const extraPatterns = extractExtraClaimPatterns(options);
  const claimPatterns = extraPatterns.length > 0 ? [...CLAIM_PATTERNS, ...extraPatterns] : CLAIM_PATTERNS;

  const lines = text
    .split(/\n+/)
    .map((line) => {
      const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
        const trimmed = sentence.trim();
        if (!trimmed) return false;
        const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, claimPatterns, context, hedgedKnowHow);
        if (sentenceForbidden.length === 0) return true;
        removed.push({ sentence: trimmed, classes: sentenceForbidden });
        return false;
      });
      return kept.join(' ').trim();
    })
    .filter(Boolean);

  return { text: lines.join('\n'), removed };
}

