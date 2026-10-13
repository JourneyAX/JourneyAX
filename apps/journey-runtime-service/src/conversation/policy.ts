import type { BusinessPackRelease } from '@journeyax/business-pack';
import defaults from '../defaults/conversation-policy.json';

export interface ConversationPolicy {
  version: string;
  stopwords: string[];
  fillerWords: string[];
  genericProductWords: string[];
  stem: { rules: Array<[string, string]>; minStem: number; keepEndings: string[] };
  relevance: { fieldWeights: { title: number; features: number; description: number; brand: number; category: number }; minIdf: number };
  sufficiency: { minTopScore: number; margin: number; within: number; maxRecommended: number; minNeedShare: number };
  show: { maxItems: number };
  ask: { maxPerConcept: number; noPreference: string };
  facets: {
    enabled: boolean; minCandidatesToAsk: number; maxExpectedRemaining: number; maxOptions: number; minShare: number; maxTermShare: number;
    /** `askFirst: false` keeps a budget question from opening the conversation: it is asked only after another question has been asked on the shelf. */
    price: { minRatio: number; askFirst: boolean }; priority: { term: number; brand: number; price: number };
    questions: { term: string; brand: string; price: string }; priceLabels: { under: string; between: string; over: string };
  };
  reason: { maxChars: number; maxSentences: number };
  answerPhrases: string[];
  /** A subset of the above that asks for steps: answered from the product's own details, never by a model. */
  howToPhrases: string[];
  /** Words that make a sentence of product text a usage instruction. */
  usageCues: string[];
  howTo: { maxSentences: number; maxChars: number };
  /** Phrases that ask to see what there is; with nothing more specific said, the answer is a short list, not a question. */
  browsePhrases: string[];
  /**
   * When the message is fully understood without the model that reads free text, that slow step is skipped: a tapped answer the
   * release or the products' own question can read, and a plain "show me" for a shelf (nothing else said).
   */
  modelReading: { skipForTappedAnswers: boolean; skipForBrowse: boolean; browseMaxWords: number; maxHeaderWords: number };
  wording: 'template' | 'model';
  templates: {
    ask: string[]; askMany: string[]; recommendOne: string[]; recommendMany: string[]; show: string[]; showNeeds: string[];
    why: string; whyNoExcerpt: string; howTo: string; howToNone: string; headingRecommend: string; headingShow: string; eyebrowRecommend: string; eyebrowShow: string;
  };
}

const PLATFORM = defaults as unknown as ConversationPolicy;
const cache = new WeakMap<object, ConversationPolicy>();

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const merge = (base: any, over: any): any => {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(over)) out[key] = key in base ? merge(base[key], value) : value;
  return out;
};

/** Platform defaults overlaid, section by section, by the pack's `extensions.dialoguePolicy` (lists and strings replace). */
export function resolveConversationPolicy(release?: BusinessPackRelease): ConversationPolicy {
  const override = (release as any)?.extensions?.dialoguePolicy;
  if (!isObject(override)) return PLATFORM;
  const cached = cache.get(override);
  if (cached) return cached;
  const merged = merge(PLATFORM, override) as ConversationPolicy;
  cache.set(override, merged);
  return merged;
}
