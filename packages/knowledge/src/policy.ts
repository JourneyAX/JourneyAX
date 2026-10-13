import { z } from 'zod';
import platformDefaults from './defaults/platform-policy.json';
import { ClaimClassSchema, type ClaimClass } from './claim-classes';

/**
 * Data-driven decision policy.
 *
 * Everything the gate used to hardcode (intent vocabulary, matching thresholds,
 * verifier roles, customer-facing sentences, SKU shape rules) lives in
 * `defaults/platform-policy.json` and can be overridden per tenant by the
 * `policy` block of an OKF release. Phrase patterns are matched by a small
 * token matcher; no regular expression is ever built from stored data.
 */

const MAX_PHRASE_TOKENS = 12;
const MAX_PHRASE_LENGTH = 160;
const MAX_MESSAGE_LENGTH = 600;
const MAX_PHRASES_PER_INTENT = 200;

const PhraseSchema = z.string().trim().min(1).max(MAX_PHRASE_LENGTH);
const IdentifierSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);

export const IntentRuleSchema = z.object({
  intent: IdentifierSchema,
  phrases: z.array(PhraseSchema).min(1).max(MAX_PHRASES_PER_INTENT),
  suppressedBy: z.array(PhraseSchema).max(MAX_PHRASES_PER_INTENT).optional(),
  /** When true the phrases are appended to the platform rule instead of replacing it. */
  extend: z.boolean().optional(),
}).strict();

export const SkuPolicySchema = z.object({
  explicitPrefixes: z.array(z.string().regex(/^[a-z0-9]{2,20}( [a-z0-9]{2,20})?$/i)).min(1).max(10),
  unlabelledMinLength: z.number().int().min(3).max(40),
  unlabelledRequireLetterAndDigit: z.boolean(),
  numericMinLength: z.number().int().min(3).max(40),
  measurementUnits: z.array(z.string().regex(/^[a-z0-9]{1,8}$/i)).max(40),
  durationWords: z.array(z.string().regex(/^[a-z]{1,12}$/i)).max(20),
}).strict();

export const MatchingPolicySchema = z.object({
  exact: z.number().min(0).max(1),
  phrase: z.number().min(0).max(1),
  tokens: z.number().min(0).max(1),
  minimum: z.number().min(0).max(1),
  wildcardMaxTokens: z.number().int().min(1).max(8),
  minPhraseLength: z.number().int().min(1).max(10),
}).strict();

export const VerifierRoleSchema = z.object({
  roleId: IdentifierSchema,
  label: z.string().min(1).max(80).optional(),
  claimClasses: z.array(ClaimClassSchema).min(1),
}).strict();

export const EvidenceClaimSchema = z.object({
  intent: IdentifierSchema.optional(),
  lens: z.enum(['product', 'project', 'problem', 'service', 'care']).optional(),
  claimClass: ClaimClassSchema,
}).strict().refine((entry) => Boolean(entry.intent) !== Boolean(entry.lens), 'exactly one of intent or lens is required');

export const CoveragePolicySchema = z.object({
  /**
   * What a plain shopping request does when no governed concept matches. Problem, safety, technical and unknown
   * requests are never configurable here: they always clarify or escalate and never get products or checkout.
   */
  uncoveredShopping: z.object({
    mode: z.enum(['blocked', 'catalogue_only']),
    commerce: z.object({
      addToCart: z.enum(['allowed_with_warning', 'blocked']),
      checkout: z.enum(['allowed', 'requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']),
    }).strict(),
  }).strict(),
}).strict();
export type CoveragePolicy = z.infer<typeof CoveragePolicySchema>;

const MessageMapSchema = z.record(IdentifierSchema, z.string().min(1).max(MAX_MESSAGE_LENGTH));

/** Full platform policy (defaults). Tenants cannot override `claimEvidence`. */
export const PlatformPolicySchema = z.object({
  policyVersion: z.string().min(1),
  locale: z.string().min(2).max(20),
  matching: MatchingPolicySchema,
  intentGroups: z.record(IdentifierSchema, z.array(IdentifierSchema).max(100)),
  intents: z.array(IntentRuleSchema.omit({ extend: true })).max(100),
  sku: SkuPolicySchema,
  verifierRoles: z.array(VerifierRoleSchema).max(50),
  claimEvidence: z.record(z.string(), z.array(z.string().min(1)).min(1)).superRefine((value, ctx) => {
    for (const key of Object.keys(value)) {
      if (!ClaimClassSchema.safeParse(key).success) ctx.addIssue({ code: 'custom', message: `unknown claim class '${key}'`, path: [key] });
    }
  }),
  evidenceClaims: z.array(EvidenceClaimSchema).max(50),
  coverage: CoveragePolicySchema,
  messages: MessageMapSchema,
}).strict();

const LocaleKeySchema = z.string().regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/);

/** Per-language lexicon and wording layered over the tenant default; lookup is exact locale, then language. */
export const OkfLocalePolicySchema = z.object({
  intents: z.array(IntentRuleSchema).max(100).optional(),
  messages: MessageMapSchema.optional(),
}).strict();

/** Tenant override block carried by an OKF release. Every field is optional. */
export const OkfTenantPolicySchema = z.object({
  locales: z.record(LocaleKeySchema, OkfLocalePolicySchema).optional(),
  locale: z.string().min(2).max(20).optional(),
  matching: MatchingPolicySchema.partial().optional(),
  intentGroups: z.record(IdentifierSchema, z.array(IdentifierSchema).max(100)).optional(),
  intents: z.array(IntentRuleSchema).max(100).optional(),
  sku: SkuPolicySchema.partial().optional(),
  verifierRoles: z.array(VerifierRoleSchema).max(50).optional(),
  evidenceClaims: z.array(EvidenceClaimSchema).max(50).optional(),
  coverage: CoveragePolicySchema.optional(),
  messages: MessageMapSchema.optional(),
}).strict();

export type OkfTenantPolicy = z.infer<typeof OkfTenantPolicySchema>;
export type PlatformPolicy = z.infer<typeof PlatformPolicySchema>;
export type SkuPolicy = z.infer<typeof SkuPolicySchema>;

// ── phrase compilation and matching ───────────────────────────────────────────

interface PhraseToken {
  kind: 'wildcard' | 'literal';
  optional: boolean;
  alternatives: Array<{ value: string; prefix: boolean }>;
}

export interface CompiledPhrase {
  source: string;
  /** True when the phrase must match at the very start of the message. */
  anchored: boolean;
  tokens: PhraseToken[];
}

/** Lower-cases, folds diacritics (so "māori" matches "maori") and keeps letters/digits of any script. */
export function foldText(value: string): string {
  return value.normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC').toLowerCase();
}

export function tokenizeText(value: string): string[] {
  return foldText(value).replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/).filter(Boolean);
}

export class PolicyPhraseError extends Error {
  constructor(public readonly phrase: string, message: string) {
    super(`${message}: '${phrase}'`);
    this.name = 'PolicyPhraseError';
  }
}

/**
 * Phrase grammar (space separated tokens):
 *   word        literal token
 *   a|b|c       any of the alternatives
 *   stem*       prefix match (a trailing * on a literal)
 *   *           one to wildcardMaxTokens arbitrary tokens
 *   token?      the token is optional
 *   ^phrase     (leading ^) the phrase must match at the start of the message
 */
export function compilePhrase(phrase: string): CompiledPhrase {
  if (phrase.length > MAX_PHRASE_LENGTH) throw new PolicyPhraseError(phrase, 'Phrase is too long');
  const anchored = phrase.trim().startsWith('^');
  const parts = phrase.trim().replace(/^\^/, '').split(/\s+/).filter(Boolean);
  if (parts.length === 0 || parts.length > MAX_PHRASE_TOKENS) {
    throw new PolicyPhraseError(phrase, `Phrase must have 1-${MAX_PHRASE_TOKENS} tokens`);
  }
  const tokens: PhraseToken[] = parts.map((raw) => {
    const optional = raw.endsWith('?') && raw.length > 1;
    const body = optional ? raw.slice(0, -1) : raw;
    if (body === '*') return { kind: 'wildcard', optional: false, alternatives: [] } as PhraseToken;
    const alternatives = body.split('|').map((alt) => {
      const prefix = alt.endsWith('*');
      const value = foldText(alt.replace(/\*$/, '')).replace(/[^\p{L}\p{N}]/gu, '');
      if (!value) throw new PolicyPhraseError(phrase, 'Empty phrase alternative');
      return { value, prefix };
    });
    return { kind: 'literal', optional, alternatives };
  });
  if (tokens.every((token) => token.kind === 'wildcard' || token.optional)) {
    throw new PolicyPhraseError(phrase, 'Phrase needs at least one required literal token');
  }
  return { source: phrase, anchored, tokens };
}

function tokenMatches(token: PhraseToken, word: string): boolean {
  return token.alternatives.some((alt) => (alt.prefix ? word.startsWith(alt.value) : word === alt.value));
}

function matchFrom(tokens: PhraseToken[], words: string[], ti: number, wi: number, wildcardMax: number): boolean {
  if (ti === tokens.length) return true;
  const token = tokens[ti];
  if (token.kind === 'wildcard') {
    for (let take = 1; take <= wildcardMax && wi + take <= words.length; take++) {
      if (matchFrom(tokens, words, ti + 1, wi + take, wildcardMax)) return true;
    }
    return false;
  }
  if (wi < words.length && tokenMatches(token, words[wi]) && matchFrom(tokens, words, ti + 1, wi + 1, wildcardMax)) return true;
  if (token.optional) return matchFrom(tokens, words, ti + 1, wi, wildcardMax);
  return false;
}

export function phraseMatches(phrase: CompiledPhrase, words: string[], wildcardMax: number): boolean {
  const last = phrase.anchored ? Math.min(0, words.length - 1) : words.length - 1;
  for (let start = 0; start <= last; start++) {
    if (matchFrom(phrase.tokens, words, 0, start, wildcardMax)) return true;
  }
  return false;
}

// ── resolution ────────────────────────────────────────────────────────────────

interface CompiledIntent {
  intent: string;
  phrases: CompiledPhrase[];
  suppressedBy: CompiledPhrase[];
}

export interface ResolvedOkfPolicy {
  locale: string;
  matching: PlatformPolicy['matching'];
  intentGroups: Map<string, Set<string>>;
  intents: CompiledIntent[];
  sku: SkuPolicy;
  verifierRoles: Map<string, { roleId: string; label?: string; claimClasses: ClaimClass[] }>;
  claimEvidence: Record<string, string[]>;
  evidenceClaims: Array<{ intent?: string; lens?: string; claimClass: ClaimClass }>;
  coverage: CoveragePolicy;
  messages: Record<string, string>;
}

const PLATFORM: PlatformPolicy = PlatformPolicySchema.parse(platformDefaults);
const resolvedCache = new WeakMap<object, Map<string, ResolvedOkfPolicy>>();
const NO_TENANT_POLICY = {};

function compileIntent(rule: { intent: string; phrases: string[]; suppressedBy?: string[] }): CompiledIntent {
  return {
    intent: rule.intent,
    phrases: rule.phrases.map(compilePhrase),
    suppressedBy: (rule.suppressedBy || []).map(compilePhrase),
  };
}

/** Exact locale first ("en-NZ"), then its language ("en"). */
function localeOverlay(tenant: OkfTenantPolicy | null | undefined, locale?: string) {
  if (!locale || !tenant?.locales) return undefined;
  const wanted = locale.trim().toLowerCase();
  const entries = Object.entries(tenant.locales);
  return entries.find(([key]) => key.toLowerCase() === wanted)?.[1]
    ?? entries.find(([key]) => key.toLowerCase() === wanted.split('-')[0])?.[1];
}

export function resolveOkfPolicy(tenant?: OkfTenantPolicy | null, locale?: string): ResolvedOkfPolicy {
  const key = (tenant as object | undefined | null) ?? NO_TENANT_POLICY;
  const localeKey = (locale || '').trim().toLowerCase();
  const perLocale = resolvedCache.get(key) ?? new Map<string, ResolvedOkfPolicy>();
  resolvedCache.set(key, perLocale);
  const cached = perLocale.get(localeKey);
  if (cached) return cached;
  const overlay = localeOverlay(tenant, locale);

  const merged = new Map<string, { intent: string; phrases: string[]; suppressedBy: string[] }>();
  for (const rule of PLATFORM.intents) {
    merged.set(rule.intent, { intent: rule.intent, phrases: [...rule.phrases], suppressedBy: [...(rule.suppressedBy || [])] });
  }
  for (const rule of [...(tenant?.intents || []), ...(overlay?.intents || [])]) {
    const existing = merged.get(rule.intent);
    if (existing && rule.extend) {
      existing.phrases.push(...rule.phrases);
      existing.suppressedBy.push(...(rule.suppressedBy || []));
    } else {
      merged.set(rule.intent, { intent: rule.intent, phrases: [...rule.phrases], suppressedBy: [...(rule.suppressedBy || [])] });
    }
  }

  const groups = new Map<string, Set<string>>();
  for (const [group, intents] of Object.entries({ ...PLATFORM.intentGroups, ...(tenant?.intentGroups || {}) })) {
    groups.set(group, new Set(intents));
  }

  const roles = new Map<string, { roleId: string; label?: string; claimClasses: ClaimClass[] }>();
  for (const role of [...PLATFORM.verifierRoles, ...(tenant?.verifierRoles || [])]) roles.set(role.roleId, role);

  const resolved: ResolvedOkfPolicy = {
    locale: (overlay ? localeKey : undefined) || tenant?.locale || PLATFORM.locale,
    matching: { ...PLATFORM.matching, ...(tenant?.matching || {}) },
    intentGroups: groups,
    intents: [...merged.values()].map(compileIntent),
    sku: { ...PLATFORM.sku, ...(tenant?.sku || {}) },
    verifierRoles: roles,
    claimEvidence: PLATFORM.claimEvidence,
    evidenceClaims: tenant?.evidenceClaims || PLATFORM.evidenceClaims,
    coverage: tenant?.coverage || PLATFORM.coverage,
    messages: { ...PLATFORM.messages, ...(tenant?.messages || {}), ...(overlay?.messages || {}) },
  };
  perLocale.set(localeKey, resolved);
  return resolved;
}

/** Validation for authoring: returns human-readable problems; empty means valid. */
export function validateOkfTenantPolicy(input: unknown): string[] {
  const parsed = OkfTenantPolicySchema.safeParse(input);
  if (!parsed.success) return parsed.error.issues.map((issue) => `policy.${issue.path.join('.')}: ${issue.message}`);
  const problems: string[] = [];
  const policy = parsed.data;
  for (const [index, rule] of (policy.intents || []).entries()) {
    for (const phrase of [...rule.phrases, ...(rule.suppressedBy || [])]) {
      try { compilePhrase(phrase); } catch (error: any) { problems.push(`policy.intents[${index}] (${rule.intent}): ${error.message}`); }
    }
  }
  const knownMessages = new Set(Object.keys(PLATFORM.messages));
  for (const key of Object.keys(policy.messages || {})) {
    if (!knownMessages.has(key)) problems.push(`policy.messages.${key}: unknown message key`);
  }
  for (const [locale, overlay] of Object.entries(policy.locales || {})) {
    for (const [index, rule] of (overlay.intents || []).entries()) {
      for (const phrase of [...rule.phrases, ...(rule.suppressedBy || [])]) {
        try { compilePhrase(phrase); } catch (error: any) { problems.push(`policy.locales.${locale}.intents[${index}] (${rule.intent}): ${error.message}`); }
      }
    }
    for (const key of Object.keys(overlay.messages || {})) {
      if (!knownMessages.has(key)) problems.push(`policy.locales.${locale}.messages.${key}: unknown message key`);
    }
  }
  const unknownPlaceholders = (template: string, key: string) => {
    const allowed = new Set(['relationshipId', 'status', 'conceptId', 'conceptName', 'reason', 'sources']);
    for (const match of template.matchAll(/\{([A-Za-z0-9_]+)\}/g)) {
      if (!allowed.has(match[1])) problems.push(`policy.messages.${key}: unknown placeholder {${match[1]}}`);
    }
  };
  for (const [key, template] of Object.entries(policy.messages || {})) unknownPlaceholders(template, key);
  for (const [locale, overlay] of Object.entries(policy.locales || {})) {
    for (const [key, template] of Object.entries(overlay.messages || {})) unknownPlaceholders(template, `${locale}.${key}`);
  }
  return problems;
}

// ── runtime helpers ───────────────────────────────────────────────────────────

export interface DetectedIntents {
  intents: string[];
}

/** Detects intents from the message using the resolved lexicon (generic, regex-free). */
export function detectIntents(message: string, policy: ResolvedOkfPolicy): DetectedIntents {
  const words = tokenizeText(message);
  const max = policy.matching.wildcardMaxTokens;
  const intents: string[] = [];
  for (const rule of policy.intents) {
    if (!rule.phrases.some((phrase) => phraseMatches(phrase, words, max))) continue;
    if (rule.suppressedBy.some((phrase) => phraseMatches(phrase, words, max))) continue;
    intents.push(rule.intent);
  }
  return { intents };
}

export function intentInGroup(policy: ResolvedOkfPolicy, group: string, intents: Iterable<string>): boolean {
  const members = policy.intentGroups.get(group);
  if (!members) return false;
  for (const intent of intents) if (members.has(intent)) return true;
  return false;
}

export function renderOkfMessage(
  messages: Record<string, string>,
  key: string,
  vars: Record<string, string | number> = {},
): string {
  const template = messages[key] ?? PLATFORM.messages[key] ?? key;
  return template.replace(/\{([A-Za-z0-9_]+)\}/g, (whole, name) => (name in vars ? String(vars[name]) : whole));
}

export function claimClassesForRole(policy: ResolvedOkfPolicy, roleId: string): ClaimClass[] | undefined {
  return policy.verifierRoles.get(roleId)?.claimClasses;
}

const escapeForRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Candidate product identifier in a message, parameterised by the SKU policy.
 * It is only a candidate; callers must confirm it against the tenant catalog.
 */
export function extractSkuCandidate(message: string, sku: SkuPolicy): string | undefined {
  const units = sku.measurementUnits.map(escapeForRegex).join('|');
  const durations = sku.durationWords.map(escapeForRegex).join('|');
  const dimension = new RegExp('^\\d+(?:x\\d+)+(?:' + (units || '(?!)') + ')?$', 'i');
  const quantity = new RegExp('^\\d+(?:\\.\\d+)?(?:' + (units || '(?!)') + ')$', 'i');
  const duration = new RegExp('^\\d{1,4}[-/]?(?:' + (durations || '(?!)') + ')s?$', 'i');
  const numeric = new RegExp('^\\d{' + sku.numericMinLength + ',}$');

  const plausible = (candidate: string): boolean => {
    if (dimension.test(candidate) || quantity.test(candidate) || duration.test(candidate)) return false;
    if (numeric.test(candidate)) return true;
    if (candidate.length < sku.unlabelledMinLength) return false;
    if (!sku.unlabelledRequireLetterAndDigit) return true;
    return /[a-z]/i.test(candidate) && /\d/.test(candidate);
  };

  for (const prefix of sku.explicitPrefixes) {
    const pattern = new RegExp('\\b' + escapeForRegex(prefix).replace(/ /g, '\\s+') + '\\s*[:#-]?\\s*([a-z0-9][a-z0-9._/-]{1,})\\b', 'i');
    const explicit = pattern.exec(message)?.[1];
    if (explicit && plausible(explicit)) return explicit;
  }
  return message.match(/\b[a-z0-9]+(?:[._/-][a-z0-9]+)*\b/gi)?.find(plausible);
}

export const OKF_PLATFORM_POLICY: Readonly<PlatformPolicy> = PLATFORM;
