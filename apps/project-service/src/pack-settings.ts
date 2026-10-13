import { CatalogMappingSchema } from '@journeyax/business-pack';

export type PackSettingsResult =
  | { ok: true; set: Record<string, unknown | null> }
  | { ok: false; message: string };

const MONEY_KEYS = ['symbols', 'leadPhrases', 'capPhrases'];

function isStringArray(value: unknown): boolean {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/** A tiny shape language for the dialogue policy: every key is checked, unknown keys are refused, nothing is silently ignored. */
type Shape =
  | { kind: 'text' } | { kind: 'texts' } | { kind: 'bool' } | { kind: 'pairs' }
  | { kind: 'number'; min: number; max: number; whole?: boolean }
  | { kind: 'choice'; values: string[] }
  | { kind: 'object'; fields: Record<string, Shape> };
const text: Shape = { kind: 'text' };
const texts: Shape = { kind: 'texts' };
const bool: Shape = { kind: 'bool' };
const whole = (min: number, max: number): Shape => ({ kind: 'number', min, max, whole: true });
const real = (min: number, max: number): Shape => ({ kind: 'number', min, max });
const object = (fields: Record<string, Shape>): Shape => ({ kind: 'object', fields });
const DIALOGUE_SHAPE = object({
  stopwords: texts, fillerWords: texts, genericProductWords: texts, answerPhrases: texts, howToPhrases: texts, usageCues: texts, browsePhrases: texts,
  howTo: object({ maxSentences: whole(1, 6), maxChars: whole(60, 800) }),
  modelReading: object({ skipForTappedAnswers: bool, skipForBrowse: bool, browseMaxWords: whole(1, 30), maxHeaderWords: whole(0, 10) }),
  stem: object({ rules: { kind: 'pairs' }, minStem: whole(1, 8), keepEndings: texts }),
  relevance: object({ fieldWeights: object({ title: real(0, 20), features: real(0, 20), description: real(0, 20), brand: real(0, 20), category: real(0, 20) }), minIdf: real(0, 5) }),
  sufficiency: object({ minTopScore: real(0, 100), margin: real(0, 1), within: real(0, 1), maxRecommended: whole(1, 6), minNeedShare: real(0, 1) }),
  show: object({ maxItems: whole(1, 12) }),
  ask: object({ maxPerConcept: whole(0, 5), noPreference: text }),
  facets: object({
    enabled: bool, minCandidatesToAsk: whole(2, 200), maxExpectedRemaining: real(0, 1), maxOptions: whole(2, 8), minShare: real(0, 1), maxTermShare: real(0, 1),
    price: object({ minRatio: real(1, 100), askFirst: bool }), priority: object({ term: real(0, 10), brand: real(0, 10), price: real(0, 10) }),
    questions: object({ term: text, brand: text, price: text }), priceLabels: object({ under: text, between: text, over: text }),
  }),
  reason: object({ maxChars: whole(40, 400), maxSentences: whole(1, 3) }),
  wording: { kind: 'choice', values: ['template', 'model'] },
  templates: object({
    ask: texts, askMany: texts, recommendOne: texts, recommendMany: texts, show: texts, showNeeds: texts,
    why: text, whyNoExcerpt: text, howTo: text, howToNone: text, headingRecommend: text, headingShow: text, eyebrowRecommend: text, eyebrowShow: text,
  }),
});
/** The only {placeholders} the platform fills in; any other would reach a customer as literal braces. */
const PLACEHOLDERS = new Set(['needs', 'title', 'excerpt', 'steps']);

function checkShape(value: unknown, shape: Shape, path: string): string | undefined {
  switch (shape.kind) {
    case 'text': return typeof value === 'string' && value.trim() ? checkPlaceholders(value, path) : `${path} must be non-empty text`;
    case 'texts': {
      if (!isStringArray(value)) return `${path} must be a list of non-empty text`;
      for (const entry of value as string[]) { const bad = checkPlaceholders(entry, path); if (bad) return bad; }
      return undefined;
    }
    case 'bool': return typeof value === 'boolean' ? undefined : `${path} must be true or false`;
    case 'pairs': return Array.isArray(value) && value.every((pair) => Array.isArray(pair) && pair.length === 2 && typeof pair[0] === 'string' && typeof pair[1] === 'string' && pair[0] !== '')
      ? undefined : `${path} must be a list of [ending, replacement] pairs`;
    case 'number': {
      const ok = typeof value === 'number' && Number.isFinite(value) && value >= shape.min && value <= shape.max && (!shape.whole || Number.isInteger(value));
      return ok ? undefined : `${path} must be ${shape.whole ? 'a whole number' : 'a number'} from ${shape.min} to ${shape.max}`;
    }
    case 'choice': return typeof value === 'string' && shape.values.includes(value) ? undefined : `${path} must be one of ${shape.values.join(', ')}`;
    case 'object': {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path || 'dialoguePolicy'} must be an object`;
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        const field = shape.fields[key];
        if (!field) return `unknown key ${path ? `${path}.` : ''}${key}`;
        const bad = checkShape(entry, field, path ? `${path}.${key}` : key);
        if (bad) return bad;
      }
      return undefined;
    }
  }
}
function checkPlaceholders(textValue: string, path: string): string | undefined {
  const unknown = [...textValue.matchAll(/\{([A-Za-z]+)\}/g)].map((match) => match[1]).filter((name) => !PLACEHOLDERS.has(name));
  return unknown.length ? `${path} uses {${unknown[0]}}, which is not filled in (use ${[...PLACEHOLDERS].map((name) => `{${name}}`).join(', ')})` : undefined;
}

/**
 * Validates tenant pack settings before they are stored. `null` removes a setting (back to platform defaults);
 * the returned map is keyed by the stored project-document path.
 */
export function validatePackSettings(dto: {
  catalogMapping?: unknown;
  interpretationPolicy?: unknown;
  workspacePinPolicy?: unknown;
  routingPolicy?: unknown;
  dialoguePolicy?: unknown;
}): PackSettingsResult {
  const set: Record<string, unknown | null> = {};

  if (dto.catalogMapping !== undefined) {
    if (dto.catalogMapping === null) {
      set.catalogMapping = null;
    } else {
      const parsed = CatalogMappingSchema.safeParse(dto.catalogMapping);
      if (!parsed.success) return { ok: false, message: `Invalid catalogMapping: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('; ')}` };
      set.catalogMapping = parsed.data;
    }
  }

  if (dto.interpretationPolicy !== undefined) {
    const policy = dto.interpretationPolicy as any;
    if (policy === null) {
      set['extensions.interpretationPolicy'] = null;
    } else {
      if (typeof policy !== 'object' || Array.isArray(policy)) return { ok: false, message: 'Invalid interpretationPolicy: expected an object' };
      const allowed = ['quantity', 'money', 'grounding', 'promptRules', 'messages', 'replyStyle'];
      const unknown = Object.keys(policy).filter((key) => !allowed.includes(key));
      if (unknown.length) return { ok: false, message: `Invalid interpretationPolicy: unknown key(s) ${unknown.join(', ')}` };
      if (policy.promptRules !== undefined && !isStringArray(policy.promptRules)) return { ok: false, message: 'Invalid interpretationPolicy: promptRules must be a list of non-empty strings' };
      if (policy.messages !== undefined && (typeof policy.messages !== 'object' || Object.values(policy.messages).some((m) => typeof m !== 'string' || !m))) {
        return { ok: false, message: 'Invalid interpretationPolicy: messages must map ids to non-empty strings' };
      }
      if (policy.replyStyle !== undefined) {
        const style = policy.replyStyle;
        if (!style || typeof style !== 'object' || Array.isArray(style)) return { ok: false, message: 'Invalid interpretationPolicy: replyStyle must be an object' };
        const unknownStyle = Object.keys(style).filter((key) => !['maxSentences', 'dropListLines', 'dropCompanyName', 'forbiddenPhrases', 'rules'].includes(key));
        if (unknownStyle.length) return { ok: false, message: `Invalid interpretationPolicy: replyStyle has unknown key(s) ${unknownStyle.join(', ')}` };
        if (style.maxSentences !== undefined && (!Number.isInteger(style.maxSentences) || style.maxSentences < 1 || style.maxSentences > 8)) return { ok: false, message: 'Invalid interpretationPolicy: replyStyle.maxSentences must be a whole number from 1 to 8' };
        for (const flag of ['dropListLines', 'dropCompanyName']) if (style[flag] !== undefined && typeof style[flag] !== 'boolean') return { ok: false, message: `Invalid interpretationPolicy: replyStyle.${flag} must be true or false` };
        for (const list of ['forbiddenPhrases', 'rules']) if (style[list] !== undefined && !isStringArray(style[list])) return { ok: false, message: `Invalid interpretationPolicy: replyStyle.${list} must be a list of non-empty strings` };
      }
      for (const key of MONEY_KEYS) {
        if (policy.money?.[key] !== undefined && !isStringArray(policy.money[key])) return { ok: false, message: `Invalid interpretationPolicy: money.${key} must be a list of non-empty strings` };
      }
      for (const key of ['unitWords', 'verbs']) {
        if (policy.quantity?.[key] !== undefined && !isStringArray(policy.quantity[key])) return { ok: false, message: `Invalid interpretationPolicy: quantity.${key} must be a list of non-empty strings` };
      }
      if (policy.grounding?.ignoredOptionWords !== undefined && !isStringArray(policy.grounding.ignoredOptionWords)) {
        return { ok: false, message: 'Invalid interpretationPolicy: grounding.ignoredOptionWords must be a list of non-empty strings' };
      }
      set['extensions.interpretationPolicy'] = policy;
    }
  }

  if (dto.workspacePinPolicy !== undefined) {
    const policy = dto.workspacePinPolicy as any;
    if (policy === null) {
      set['extensions.workspacePinPolicy'] = null;
    } else {
      const hours = policy?.idleRepinAfterHours;
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24 * 365) {
        return { ok: false, message: 'Invalid workspacePinPolicy: idleRepinAfterHours must be a positive number of hours (at most one year)' };
      }
      set['extensions.workspacePinPolicy'] = { idleRepinAfterHours: hours };
    }
  }

  // How the assistant decides each turn. Sections replace the platform defaults one by one; anything unset stays default.
  if (dto.dialoguePolicy !== undefined) {
    if (dto.dialoguePolicy === null) {
      set['extensions.dialoguePolicy'] = null;
    } else {
      const bad = checkShape(dto.dialoguePolicy, DIALOGUE_SHAPE, '');
      if (bad) return { ok: false, message: `Invalid dialoguePolicy: ${bad}` };
      set['extensions.dialoguePolicy'] = dto.dialoguePolicy;
    }
  }

  // Which journey answers a request that matches none. A project with several journeys cannot be published without one, and the
  // publisher never guesses it. Whether the id names a real journey is checked at publication, where the journeys are known.
  if (dto.routingPolicy !== undefined) {
    const policy = dto.routingPolicy as any;
    if (policy === null) {
      set.routingPolicy = null;
    } else {
      if (typeof policy !== 'object' || Array.isArray(policy)) return { ok: false, message: 'Invalid routingPolicy: expected an object' };
      const unknown = Object.keys(policy).filter((key) => !['defaultJourneyId', 'fallbackOnCatalogSearch'].includes(key));
      if (unknown.length) return { ok: false, message: `Invalid routingPolicy: unknown key(s) ${unknown.join(', ')}` };
      if (typeof policy.defaultJourneyId !== 'string' || !policy.defaultJourneyId.trim()) {
        return { ok: false, message: 'Invalid routingPolicy: defaultJourneyId must name a journey' };
      }
      if (policy.fallbackOnCatalogSearch !== undefined && typeof policy.fallbackOnCatalogSearch !== 'boolean') {
        return { ok: false, message: 'Invalid routingPolicy: fallbackOnCatalogSearch must be true or false' };
      }
      set.routingPolicy = {
        defaultJourneyId: policy.defaultJourneyId.trim(),
        ...(policy.fallbackOnCatalogSearch === undefined ? {} : { fallbackOnCatalogSearch: policy.fallbackOnCatalogSearch }),
      };
    }
  }

  return { ok: true, set };
}
