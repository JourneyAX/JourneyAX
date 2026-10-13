import type { ClaimClass } from '@journeyax/knowledge';

const CLAIM_PATTERNS: ReadonlyArray<[ClaimClass, RegExp]> = [
  ['warranty', /\b(?:warrant(?:y|ies|ed)|guarantee(?:d|s)?|covered for \d+)\b/i],
  ['legal_requirement', /\b(?:compli(?:ant|ance|es|ed|y)|building code|regulat(?:ion|ory)|legally|by law|certified to)\b/i],
  ['compatibility', /\b(?:compatib(?:le|ility)|fits? (?:with|every|all|the)|works? with|suitable for)\b/i],
  ['substitution', /\b(?:equivalent|substitut(?:e|ion)|interchangeable|replacement for)\b/i],
  ['installation_step', /\b(?:install|mount|attach|drill|wire|fix(?:ing)? to|connect to|fasten)\b/i],
  ['care_safety', /\b(?:dilut(?:e|ion)|abrasive|chemical|ventilat(?:e|ion)|clean(?:er|ing)? safely)\b/i],
  ['safety_instruction', /\b(?:safe to|unsafe|hazard|danger|isolate (?:the )?(?:water|power)|shut off|turn off (?:the )?(?:water|power)|protective equipment)\b/i],
  ['requirement', /\b(?:must|mandatory|required|requires?|need(?:s)? to|necessary)\b/i],
  ['catalog_fact', /(?:\$\s?\d|\b(?:in stock|out of stock|available now|sku\s*[:#]|costs?\s+\d|price(?:d)? at)\b)/i],
];

/**
 * Deterministic fail-closed check for regulated and transactional claim forms.
 * Questions do not assert a claim. This lexical check is only a final guard;
 * model text is still sourced from the pinned release and live capabilities.
 */
export function validateOkfGeneratedClaims(text: string, allowedClasses: ClaimClass[]): {
  valid: boolean;
  forbidden: ClaimClass[];
} {
  const allowed = new Set(allowedClasses);
  const forbidden = new Set<ClaimClass>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const trimmed = sentence.trim();
    if (!trimmed || trimmed.endsWith('?')) continue;
    for (const [claim, pattern] of CLAIM_PATTERNS) {
      if (!allowed.has(claim) && pattern.test(trimmed)) forbidden.add(claim);
    }
  }
  return { valid: forbidden.size === 0, forbidden: [...forbidden] };
}

export interface WithheldSentence { sentence: string; classes: ClaimClass[] }

/**
 * The same check, applied one sentence at a time. A reply that makes one unsupported claim keeps its other sentences, because a single
 * ordinary word ("fastening timber" in a product description) should not cost the customer the whole answer; the sentences that do
 * assert a claim class the release does not allow are removed, never rewritten. A reply that is nothing but such sentences comes back
 * empty and the caller says so in the tenant's own wording.
 */
export function withholdUnsupportedClaims(text: string, allowedClasses: ClaimClass[]): { text: string; removed: WithheldSentence[] } {
  const allowed = new Set(allowedClasses);
  const removed: WithheldSentence[] = [];
  const lines = text.split(/\n+/).map((line) => {
    const kept = line.split(/(?<=[.!?])\s+/).filter((sentence) => {
      const trimmed = sentence.trim();
      if (!trimmed) return false;
      if (trimmed.endsWith('?')) return true;
      const classes = CLAIM_PATTERNS.filter(([claim, pattern]) => !allowed.has(claim) && pattern.test(trimmed)).map(([claim]) => claim);
      if (classes.length === 0) return true;
      removed.push({ sentence: trimmed, classes });
      return false;
    });
    return kept.join(' ').trim();
  }).filter(Boolean);
  return { text: lines.join('\n'), removed };
}
