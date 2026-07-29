/**
 * Needs-based language mapping (AUG-67).
 *
 * Customers ask in NEEDS ("something modern", "clean and classic", "lots of
 * colour"); the catalogue stores ATTRIBUTES. Pure vector similarity silently
 * drops those words — which is how "modern" went unhonoured and how a soccer
 * query surfaced football. This module turns needs into the vocabulary our own
 * data already speaks.
 *
 * GROUNDED, NOT GUESSED. The design-visuals stage measures every design line and
 * writes a `character` array (see pipeline stageDesignVisuals/stageDesignKnowledge):
 *   'bold — accents dominate'
 *   'balanced — clear accents on a solid base'
 *   'subtle — mostly one colour'
 *   'minimal decoration'
 *   'N% fine detail — piping or pinstripe'
 *   'N% band across the upper garment'
 * Those phrases are produced by OUR pipeline, so mapping onto them is mapping
 * onto measured fact — not onto a design line's NAME. Naming is exactly what we
 * must not trust: "BOLT" measures as subtle because one of its zones failed to
 * render, so a name-based guess would be confidently wrong.
 *
 * No brand data is hardcoded here: the right-hand side is our own derived
 * taxonomy, and the concrete design lines/colours/styles it selects come from the
 * catalogue at query time.
 */

/** Measured phrases the visual reader emits, as substrings we can match on. */
export const CHARACTER_AXIS = {
  bold: 'bold — accents dominate',
  balanced: 'balanced — clear accents on a solid base',
  subtle: 'subtle — mostly one colour',
  minimal: 'minimal decoration',
  fineDetail: 'fine detail — piping or pinstripe',
  band: 'band across the upper garment',
} as const;

/**
 * Customer vocabulary → measured character. Left side is how people actually
 * talk; right side is what the pipeline measured.
 */
const NEEDS_TO_CHARACTER: { terms: string[]; character: string[] }[] = [
  { terms: ['modern', 'bold', 'aggressive', 'loud', 'striking', 'eye catching', 'eye-catching', 'stand out', 'flashy', 'dynamic', 'sharp'],
    character: [CHARACTER_AXIS.bold] },
  { terms: ['classic', 'traditional', 'clean', 'simple', 'understated', 'plain', 'minimal', 'conservative', 'timeless', 'old school'],
    character: [CHARACTER_AXIS.subtle, CHARACTER_AXIS.minimal] },
  { terms: ['balanced', 'moderate', 'not too loud', 'tasteful'],
    character: [CHARACTER_AXIS.balanced] },
  { terms: ['pinstripe', 'pin stripe', 'piping', 'trim', 'fine detail', 'detailing'],
    character: [CHARACTER_AXIS.fineDetail] },
  { terms: ['band', 'chest stripe', 'shoulder stripe', 'yoke'],
    character: [CHARACTER_AXIS.band] },
  { terms: ['colourful', 'colorful', 'multi colour', 'multi-colour', 'multi color', 'lots of colour', 'lots of color'],
    character: [CHARACTER_AXIS.bold] },
];

export interface ResolvedNeeds {
  /** Query rewritten in the catalogue's own measured vocabulary. */
  expandedQuery: string;
  /** Measured character phrases the customer implied (for ranking). */
  character: string[];
  /** Plain-language reasons, so the agent can explain WHY it chose. */
  matched: string[];
}

/**
 * Resolve a customer utterance into measured vocabulary.
 *
 * Deliberately ADDITIVE: we append measured phrasing rather than replacing the
 * customer's words, so a need we don't recognise can never make retrieval worse
 * than it is today. Returns the original query untouched when nothing matches.
 */
export function resolveNeeds(query: string): ResolvedNeeds {
  const q = ` ${String(query || '').toLowerCase()} `;
  const character: string[] = [];
  const matched: string[] = [];

  for (const rule of NEEDS_TO_CHARACTER) {
    const hit = rule.terms.find((t) => q.includes(` ${t} `) || q.includes(`${t} `) || q.includes(` ${t}`));
    if (!hit) continue;
    for (const c of rule.character) if (!character.includes(c)) character.push(c);
    matched.push(hit);
  }

  const expandedQuery = character.length ? `${query} ${character.join(' ')}` : query;
  return { expandedQuery, character, matched };
}

/**
 * Is this measured reading trustworthy?
 *
 * The visual reader flags its own failures. A partial render produces a reading
 * that is not merely incomplete but WRONG in the confident direction — a design
 * whose accent zones failed to draw measures as "subtle". Because this mapping
 * runs fully automatically with no human review, an unreliable reading must be
 * dropped rather than trusted.
 */
export function isReliableCharacter(character: string[] | undefined): boolean {
  if (!character?.length) return false;
  return !character.some((c) => /^(WARNING|PARTIAL)\b/i.test(String(c).trim()));
}

/** Design lines differ only by case in the feed (A-STRIPE / A-Stripe / A-stripe). */
export function normaliseDesignLine(name: string): string {
  return String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
}
