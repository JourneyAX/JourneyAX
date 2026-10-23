import type { ClaimClass } from '@journeyax/knowledge';

export interface ClaimValidatorOptions {
  locale?: string;
  referrals?: Record<string, string[]> | string[];
  extraClaimPatterns?: Partial<Record<ClaimClass, (string | RegExp)[]>> | Record<string, Partial<Record<ClaimClass, (string | RegExp)[]>>>;
}

const CLAIM_PATTERNS: ReadonlyArray<[ClaimClass, RegExp]> = [
  ['warranty', /\b(?:warrant(?:y|ies|ed)|guarantee(?:d|s)?|covered for \d+)\b/i],
  ['legal_requirement', /\b(?:compli(?:ant|ance|es|ed|y)|building code|regulat(?:ion|ory)|legally|by law|certified to)\b/i],
  ['compatibility', /\b(?:compatib(?:le|ility)|fits? (?:with|every|all|the)|works? with|suitable for)\b/i],
  ['substitution', /\b(?:equivalent|substitut(?:e|ion)|interchangeable|replacement for)\b/i],
  ['installation_step', /\b(?:install|mount|attach|drill|wire|fix(?:ing)? to|connect to|fasten)\b/i],
  ['care_safety', /\b(?:dilut(?:e|es|ed|ing|ion)|abrasive|chemical|ventilat(?:e|es|ed|ing|ion)|clean(?:er|ing)? safely)\b/i],
  [
    'safety_instruction',
    /\b(?:safe to|unsafe|hazard|danger|isolat(?:e|es|ing) (?:the |your |it |them )?\w+|(?:turn|switch|shut)(?: \w+){0,3}? off|(?:avoid|stop) using|(?:do not|don't|never) use|protective equipment|(?:wear|use) (?:\w+ ){0,2}(?:respirators?|masks?|gloves|goggles|glasses|protective)|load-bearing|load bearing|structural (?:grade|grades|beam|beams|support|member|wall|application|applications)|handle the load|stress associated with structural|(?:near|around) (?:power )?outlets?|electrical (?:wiring|circuit|cables?|shocks?)|mains (?:power|wiring|supply)|wire to|wiring to|connect to mains)\b/i,
  ],
  ['requirement', /\b(?:must|mandatory|required|requires?|need(?:s)? to|necessary)\b/i],
  ['catalog_fact', /(?:\$\s?\d|\b(?:sku\s*[:#]|costs?\s+\d|price(?:d)? at)\b)/i],
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

function isIntroductoryTopicPhrase(clause: string): boolean {
  const trimmed = clause.trim();
  if (!/^(?:for|regarding|as for|in case of|with respect to|when considering)\b/i.test(trimmed)) {
    return false;
  }
  if (/\b(?:is|are|has|have|was|were|must|requires?|install|drill|mount|wire|fasten|fits?|suitable|use|apply)\b/i.test(trimmed)) {
    return false;
  }
  return true;
}

function checkSentenceForClaims(
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

/**
 * Deterministic fail-closed check for regulated and transactional claim forms.
 * Questions do not assert a claim. This lexical check is only a final guard;
 * model text is still sourced from the pinned release and live capabilities.
 */
export function validateOkfGeneratedClaims(
  text: string,
  allowedClasses: ClaimClass[],
  options?: ClaimValidatorOptions | any
): {
  valid: boolean;
  forbidden: ClaimClass[];
} {
  const allowed = new Set(allowedClasses);
  const forbidden = new Set<ClaimClass>();
  const referralPatterns = extractReferralPatterns(options);

  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.endsWith('?')) continue;
    const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, CLAIM_PATTERNS);
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
  options?: ClaimValidatorOptions | any
): { text: string; removed: WithheldSentence[] } {
  const allowed = new Set(allowedClasses);
  const removed: WithheldSentence[] = [];
  const referralPatterns = extractReferralPatterns(options);

  const lines = text
    .split(/\n+/)
    .map((line) => {
      const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
        const trimmed = sentence.trim();
        if (!trimmed) return false;
        if (trimmed.endsWith('?')) return true;
        const sentenceForbidden = checkSentenceForClaims(trimmed, allowed, referralPatterns, CLAIM_PATTERNS);
        if (sentenceForbidden.length === 0) return true;
        removed.push({ sentence: trimmed, classes: sentenceForbidden });
        return false;
      });
      return kept.join(' ').trim();
    })
    .filter(Boolean);

  return { text: lines.join('\n'), removed };
}

