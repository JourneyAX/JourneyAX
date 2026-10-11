import type { BusinessPackRelease } from '@journeyax/business-pack';
import defaults from '../defaults/interpretation-policy.json';

/**
 * What a fact MEANS comes from the published pack (fact registry `role`/`multiple`, entity attribute
 * types), never from the spelling of its key.
 */
export type FactRole = 'measurement' | 'money' | 'quantity';

export interface InterpretationPolicy {
  version: string;
  quantity: { unitWords: string[]; verbs: string[] };
  money: { symbols: string[]; leadPhrases: string[]; capPhrases: string[] };
  grounding: { ignoredOptionWords: string[] };
  promptRules: string[];
  messages: Record<string, string>;
}

const PLATFORM_POLICY = defaults as InterpretationPolicy;
const cache = new WeakMap<object, InterpretationPolicy>();

/** Platform defaults overlaid by the pack's `extensions.interpretationPolicy` (arrays and strings replace). */
export function resolveInterpretationPolicy(release?: BusinessPackRelease): InterpretationPolicy {
  const override = (release as any)?.extensions?.interpretationPolicy;
  if (!override || typeof override !== 'object') return PLATFORM_POLICY;
  const cached = cache.get(override);
  if (cached) return cached;
  const merged: InterpretationPolicy = {
    ...PLATFORM_POLICY,
    quantity: { ...PLATFORM_POLICY.quantity, ...(override.quantity || {}) },
    money: { ...PLATFORM_POLICY.money, ...(override.money || {}) },
    grounding: { ...PLATFORM_POLICY.grounding, ...(override.grounding || {}) },
    promptRules: Array.isArray(override.promptRules) ? override.promptRules : PLATFORM_POLICY.promptRules,
    messages: { ...PLATFORM_POLICY.messages, ...(override.messages || {}) },
  };
  cache.set(override, merged);
  return merged;
}

function definitions(release: BusinessPackRelease, key: string): { registry?: any; entity?: any; attribute?: any } {
  const registry = (release as any).factRegistry?.facts?.[key];
  const entity: any = (release.entities?.entities || []).find(
    (e: any) => e.entityName === key || e.entityId === key || e.name === key,
  );
  const attribute: any = entity?.attributes?.find((a: any) => a.name === key);
  return { registry, entity, attribute };
}

const ROLE_BY_TYPE: Record<string, FactRole> = {
  measurement: 'measurement', currency: 'money', money: 'money', quantity: 'quantity',
};

export function resolveFactRole(release: BusinessPackRelease, key: string): FactRole | undefined {
  const { registry, entity, attribute } = definitions(release, key);
  if (registry?.role) return registry.role as FactRole;
  for (const type of [entity?.type, attribute?.type]) {
    if (typeof type === 'string' && ROLE_BY_TYPE[type]) return ROLE_BY_TYPE[type];
  }
  return undefined;
}

export function isListFact(release: BusinessPackRelease, key: string): boolean {
  const { registry, entity, attribute } = definitions(release, key);
  return registry?.multiple === true ||
    registry?.type === 'array' ||
    registry?.uiInputType === 'multi_select' ||
    entity?.multiple === true || entity?.type === 'array' ||
    attribute?.multiple === true || attribute?.type === 'array';
}

/** The single declared fact with this role, or undefined when there are none or several (never guess). */
export function uniqueFactWithRole(release: BusinessPackRelease, keys: Iterable<string>, role: FactRole): string | undefined {
  const matches = [...keys].filter((key) => resolveFactRole(release, key) === role);
  return matches.length === 1 ? matches[0] : undefined;
}

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const alternation = (values: string[]) => [...values].sort((a, b) => b.length - a.length).map(escape).join('|');

export interface CompiledExpressions {
  quantity: RegExp[];
  money: RegExp[];
}

const compiled = new WeakMap<InterpretationPolicy, CompiledExpressions>();

export function compileExpressions(policy: InterpretationPolicy): CompiledExpressions {
  const hit = compiled.get(policy);
  if (hit) return hit;
  const quantity: RegExp[] = [];
  if (policy.quantity.unitWords.length) quantity.push(new RegExp(`(\\d+)\\s*(?:${alternation(policy.quantity.unitWords)})s?\\b`, 'i'));
  if (policy.quantity.verbs.length) quantity.push(new RegExp(`(?:${alternation(policy.quantity.verbs)})\\s*(\\d+)`, 'i'));
  const money: RegExp[] = [];
  if (policy.money.symbols.length) {
    const lead = policy.money.leadPhrases.length ? `(?:${alternation(policy.money.leadPhrases)})?` : '';
    money.push(new RegExp(`${lead}\\s*(?:${alternation(policy.money.symbols)})(\\d+(?:\\.\\d{2})?)`, 'i'));
  }
  if (policy.money.capPhrases.length) money.push(new RegExp(`(?:${alternation(policy.money.capPhrases)})\\s+(\\d+(?:\\.\\d{2})?)`, 'i'));
  const result = { quantity, money };
  compiled.set(policy, result);
  return result;
}

export function firstCapture(expressions: RegExp[], text: string): number | undefined {
  for (const expression of expressions) {
    const match = text.match(expression);
    if (match) {
      const value = Number(match[1]);
      if (!Number.isNaN(value) && value > 0) return value;
    }
  }
  return undefined;
}
