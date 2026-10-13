/**
 * Pure helpers for the OKF Studio. They only shape data the server already owns:
 * hashes are rebound by the server on save and readiness is computed by the server's analysis endpoint,
 * so nothing here decides what may be published.
 */
export type Tone = 'ok' | 'warn' | 'bad' | 'neutral';

export interface StalenessEntry {
  targetType: 'concept' | 'relationship';
  targetId: string;
  reason: 'edited_since_verification' | 'unverified' | 'expired';
  /** What the check is about, set by the service for work that has not been done yet. */
  about?: WorkTopic;
}

export interface ReadinessCheck { id: string; ok: boolean; detail?: string; advisory?: boolean }

/** Customer-facing copy lives with the UI, keyed by the server's check ids. */
export const CHECK_LABELS: Record<string, string> = {
  draft_present: 'A draft exists',
  draft_valid: 'The draft passes validation',
  verifications_current: 'Advice that needs a person to confirm it',
  release_published: 'An immutable release is published',
  artifact_exported: 'The release artifact is exported and verified',
};

export const STALENESS_LABELS: Record<StalenessEntry['reason'], string> = {
  edited_since_verification: 'Edited since it was verified',
  unverified: 'Not verified',
  expired: 'Verification expired',
};

export function parseList(text: string): string[] {
  return [...new Set(text.split(/[\n,]/).map((item) => item.trim()).filter(Boolean))];
}

export function formatList(values: string[] | undefined): string {
  return (values || []).join(', ');
}

function verificationFor(content: any, targetType: 'concept' | 'relationship', targetId: string) {
  return (content?.verifications || []).find((record: any) => record.targetType === targetType && record.targetId === targetId);
}

const bareHash = (hash?: string) => (hash || '').replace(/^sha256:/, '');

export function relationshipBadge(content: any, relationship: any): { label: string; tone: Tone; detail: string } {
  const record = verificationFor(content, 'relationship', relationship.relationshipId);
  if (!record && !relationshipMakesClaim(relationship)) {
    return { label: 'No claim', tone: 'neutral', detail: 'This link only places a topic in the catalogue or suggests an add-on. It states nothing a customer could rely on, so there is nothing to verify.' };
  }
  if (!record || record.status === 'unverified') {
    return { label: 'Unverified', tone: 'bad', detail: 'Cannot support compatibility, requirement, safety or substitution claims.' };
  }
  if (record.status === 'in_review') {
    return { label: 'In review', tone: 'warn', detail: 'Waiting for the assigned verifier.' };
  }
  if (bareHash(record.contentHash) !== bareHash(relationship.contentHash)) {
    return { label: 'Edited — re-verify', tone: 'warn', detail: 'Content changed after verification; the old verification no longer applies.' };
  }
  if (record.staleAfter && new Date(record.staleAfter) <= new Date()) {
    return { label: 'Verification expired', tone: 'warn', detail: `Expired ${record.staleAfter}.` };
  }
  return { label: 'Verified', tone: 'ok', detail: `Verified by ${record.verifiedBy} (${record.verifierRole}).` };
}

export type WorkTopic = 'safety' | 'care' | 'compatibility' | 'documents';

/** Plain-language copy for each kind of check, in the order a business should work through them. */
export const WORK_TOPICS: Array<{ topic: WorkTopic; title: string; why: string; optional: boolean }> = [
  { topic: 'safety', title: 'Problems and safety', optional: false,
    why: 'What to tell a customer first when something goes wrong (a leak, a gas smell). Until a qualified person writes and confirms it, the assistant tells the customer to contact a professional.' },
  { topic: 'care', title: 'Care advice', optional: false,
    why: 'How to look after something (a deck, a tap). Until a person confirms it, the assistant gives no care steps.' },
  { topic: 'compatibility', title: 'What goes with what', optional: false,
    why: 'Fixings and fittings where the wrong choice causes harm. Until a person confirms the guidance, the assistant shows the range and asks the customer to check before they buy.' },
  { topic: 'documents', title: 'Manufacturer documents to review', optional: true,
    why: 'Installation guides and warranties found for a category. When a person confirms a document applies, the assistant can use it for that category. There is no deadline: until then the assistant says it cannot confirm installation or warranty details.' },
];

/** Friendly names for the closed list of relationship types; anything new falls back to its own words. */
export const RELATIONSHIP_LABELS: Record<string, string> = {
  child_of: 'sits inside',
  cross_sell: 'goes well with',
  care_for: 'is cared for with',
  relevant_to: 'is relevant to',
  requires: 'needs',
  compatible_with: 'works with',
  incompatible_with: 'does not work with',
  alternative_to: 'can replace',
  installed_with: 'is installed with',
  solves: 'solves',
  diagnoses: 'diagnoses',
  document_for: 'is documented by',
  escalates_to: 'escalates to',
};

export const relationshipWords = (type: string) => RELATIONSHIP_LABELS[type] ?? type.replace(/_/g, ' ');

/** A relationship with no claim class asserts nothing a customer could be told, so there is nothing for a person to verify. */
export const relationshipMakesClaim = (relationship: any) => Array.isArray(relationship?.claimClasses) && relationship.claimClasses.length > 0;

/**
 * Where a topic lives for a person scanning a list: a catalogue topic sits under its department (the top of its "sits inside" chain),
 * every other kind (a problem, a care guide, a project) under its own kind.
 */
export function areaResolver(content: any): (entry: { targetType: 'concept' | 'relationship'; targetId: string }) => string {
  const concepts = new Map<string, any>((content?.concepts || []).map((concept: any) => [concept.conceptId, concept]));
  const relationships = new Map<string, any>((content?.relationships || []).map((relationship: any) => [relationship.relationshipId, relationship]));
  const parent = new Map<string, string>();
  for (const relationship of relationships.values()) if (relationship.type === 'child_of') parent.set(relationship.from, relationship.to);
  const top = (conceptId: string) => {
    let current = conceptId;
    for (const seen = new Set<string>(); parent.has(current) && !seen.has(current);) { seen.add(current); current = parent.get(current)!; }
    return current;
  };
  const KIND: Record<string, string> = { problem: 'Problems', care: 'Care guides', project: 'Projects', service: 'Services' };
  return (entry) => {
    const conceptId = entry.targetType === 'concept' ? entry.targetId : relationships.get(entry.targetId)?.from;
    const concept = conceptId ? concepts.get(conceptId) : undefined;
    if (!concept) return 'Other';
    if (concept.lens !== 'product') return KIND[concept.lens] ?? concept.lens;
    return concepts.get(top(concept.conceptId))?.name ?? concept.name;
  };
}

export interface WorkItem { entry: StalenessEntry; label: string }
export interface WorkArea { area: string; items: WorkItem[] }
export interface WorkGroup { topic: WorkTopic; title: string; why: string; optional: boolean; count: number; areas: WorkArea[] }

/**
 * The list a business works through: what changed since it was confirmed first (those lost a confirmation they had), then each kind
 * of check, safety first, each split by the part of the shop it belongs to. Pure shaping of what the service listed.
 */
export function groupVerificationWork(entries: StalenessEntry[], content: any): { changed: WorkItem[]; groups: WorkGroup[] } {
  const area = areaResolver(content);
  const names = new Map<string, string>((content?.concepts || []).map((concept: any) => [concept.conceptId, concept.name]));
  const relationships = new Map<string, any>((content?.relationships || []).map((relationship: any) => [relationship.relationshipId, relationship]));
  const label = (entry: StalenessEntry) => {
    if (entry.targetType === 'concept') return names.get(entry.targetId) ?? entry.targetId;
    const relationship = relationships.get(entry.targetId);
    return relationship ? `${names.get(relationship.from) ?? relationship.from} ${relationshipWords(relationship.type)} ${names.get(relationship.to) ?? relationship.to}` : entry.targetId;
  };
  const item = (entry: StalenessEntry): WorkItem => ({ entry, label: label(entry) });
  const changed = entries.filter((entry) => entry.reason !== 'unverified').map(item);
  const open = entries.filter((entry) => entry.reason === 'unverified');
  const groups = WORK_TOPICS.map((meta) => {
    const mine = open.filter((entry) => (entry.about ?? 'documents') === meta.topic);
    const byArea = new Map<string, WorkItem[]>();
    for (const entry of mine) {
      const key = area(entry);
      byArea.set(key, [...(byArea.get(key) ?? []), item(entry)]);
    }
    const areas = [...byArea.entries()].map(([name, items]) => ({ area: name, items })).sort((a, b) => b.items.length - a.items.length || (a.area < b.area ? -1 : 1));
    return { ...meta, count: mine.length, areas };
  }).filter((group) => group.count > 0);
  return { changed, groups };
}

/** One assignment per target, written together so a department can be handed to a person in one save. */
export function assignVerifiers(
  content: any,
  targets: Array<{ targetType: 'concept' | 'relationship'; targetId: string }>,
  input: { verifiedBy: string; verifierRole: string; now?: Date },
): any {
  return targets.reduce((next, target) => assignVerifier(next, { ...target, ...input }), content);
}

export function groupStaleness(entries: StalenessEntry[]): Array<{ reason: StalenessEntry['reason']; label: string; entries: StalenessEntry[] }> {
  const order: StalenessEntry['reason'][] = ['edited_since_verification', 'expired', 'unverified'];
  return order
    .map((reason) => ({ reason, label: STALENESS_LABELS[reason], entries: entries.filter((entry) => entry.reason === reason) }))
    .filter((group) => group.entries.length > 0);
}

export interface ConceptPatch {
  name?: string;
  description?: string;
  synonyms?: string[];
  customerPhrases?: string[];
  riskClass?: 'standard' | 'compatibility' | 'safety_critical';
  compatibilitySensitive?: boolean;
  addToCart?: 'allowed' | 'allowed_with_warning' | 'blocked';
  checkout?: 'allowed' | 'requires_compatibility_resolution' | 'requires_professional_confirmation' | 'blocked';
  blocksProducts?: boolean;
  lifecycleStatus?: 'active_draft' | 'deprecated' | 'retired';
  requiredFacts?: Array<{ factKey: string; importance: 'high' | 'medium' | 'low' }>;
  catalogCategoryIds?: string[];
}

/** Returns a copy of the draft with one concept edited. contentHash is deliberately left for the server to rebind. */
export function patchConcept(content: any, conceptId: string, patch: ConceptPatch): any {
  if (!(content?.concepts || []).some((concept: any) => concept.conceptId === conceptId)) {
    throw new Error(`Concept ${conceptId} is not in the draft`);
  }
  return {
    ...content,
    concepts: content.concepts.map((concept: any) => {
      if (concept.conceptId !== conceptId) return concept;
      const next = { ...concept };
      if (patch.name !== undefined) next.name = patch.name;
      if (patch.description !== undefined) next.description = patch.description;
      if (patch.synonyms) next.synonyms = patch.synonyms;
      if (patch.customerPhrases) next.customerPhrases = patch.customerPhrases;
      if (patch.riskClass) next.riskClass = patch.riskClass;
      if (patch.compatibilitySensitive !== undefined) next.compatibilitySensitive = patch.compatibilitySensitive;
      if (patch.addToCart || patch.checkout) {
        next.commercePolicy = { ...concept.commercePolicy, ...(patch.addToCart ? { addToCart: patch.addToCart } : {}), ...(patch.checkout ? { checkout: patch.checkout } : {}) };
      }
      if (patch.blocksProducts !== undefined) next.safety = { ...concept.safety, blocksProducts: patch.blocksProducts };
      if (patch.lifecycleStatus) next.lifecycle = { ...concept.lifecycle, status: patch.lifecycleStatus };
      if (patch.requiredFacts) next.requiredFacts = patch.requiredFacts;
      if (patch.catalogCategoryIds) next.searchScope = { ...concept.searchScope, catalogCategoryIds: patch.catalogCategoryIds };
      return next;
    }),
  };
}

/**
 * Assigns a verifier to a target by writing a verification record bound to the target's current hash.
 * The record still needs the verifier's own server-side attestation before it can ship.
 */
export function assignVerifier(
  content: any,
  input: { targetType: 'concept' | 'relationship'; targetId: string; verifiedBy: string; verifierRole: string; now?: Date },
): any {
  const collection = input.targetType === 'concept' ? content.concepts : content.relationships;
  const idKey = input.targetType === 'concept' ? 'conceptId' : 'relationshipId';
  const target = (collection || []).find((entity: any) => entity[idKey] === input.targetId);
  if (!target) throw new Error(`${input.targetType} ${input.targetId} is not in the draft`);
  if (!input.verifiedBy.trim() || !input.verifierRole.trim()) throw new Error('A verifier and a verifier role are required');
  const existing = verificationFor(content, input.targetType, input.targetId);
  const record = {
    ...(existing || {}),
    recordId: existing?.recordId || `ver-${input.targetType}-${input.targetId}`.replace(/[^a-zA-Z0-9._:/-]+/g, '-'),
    targetType: input.targetType,
    targetId: input.targetId,
    status: 'verified',
    sourceRefs: existing?.sourceRefs || target.sourceRefs || target.evidenceRefs || [],
    verifiedBy: input.verifiedBy.trim(),
    verifierRole: input.verifierRole.trim(),
    verifiedAt: (input.now || new Date()).toISOString(),
    contentHash: target.contentHash,
  };
  return {
    ...content,
    verifications: existing
      ? content.verifications.map((candidate: any) => (candidate === existing ? record : candidate))
      : [...(content.verifications || []), record],
  };
}

export function revocationTone(status: 'active' | 'lifted' | 'expired'): Tone {
  return status === 'active' ? 'bad' : status === 'lifted' ? 'ok' : 'neutral';
}

export function splitRevocations<T extends { status: string }>(items: T[]): { active: T[]; history: T[] } {
  return { active: items.filter((item) => item.status === 'active'), history: items.filter((item) => item.status !== 'active') };
}

export const ENVIRONMENTS = ['dev', 'test', 'staging', 'production'] as const;
export type EnvironmentId = typeof ENVIRONMENTS[number];

export type SettingKey = 'catalogMapping' | 'routingPolicy' | 'interpretationPolicy' | 'workspacePinPolicy' | 'dialoguePolicy';
export interface SettingStatus { state: 'set' | 'defaults' | 'missing'; text: string }

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const keysOf = (value: unknown) => (isObject(value) ? Object.keys(value) : []);
const words = (keys: string[]) => keys.map((key) => key.replace(/([A-Z])/g, ' $1').toLowerCase()).join(', ');

/**
 * What each pack setting is doing right now, in a sentence a person can read without opening it. An empty box does not mean
 * "unassigned": for most of these, nothing set means the platform's built-in behaviour, and that is said outright.
 */
export function settingStatus(key: SettingKey, project: any): SettingStatus {
  const value = key === 'catalogMapping' ? project?.catalogMapping
    : key === 'routingPolicy' ? project?.routingPolicy
    : project?.extensions?.[key];
  const customised = isObject(value) && Object.keys(value).length > 0;
  switch (key) {
    case 'catalogMapping':
      return customised
        ? { state: 'set', text: `Set: ${words(keysOf(value))}.` }
        : { state: 'defaults', text: 'Not set: product fields are read by their usual names, and a price without a currency is never quoted.' };
    case 'routingPolicy': {
      const journey = isObject(value) ? value.defaultJourneyId : undefined;
      return typeof journey === 'string' && journey
        ? { state: 'set', text: `Set: requests no other journey matches go to “${journey}”${isObject(value) && value.fallbackOnCatalogSearch ? ' (and plain catalogue searches too)' : ''}.` }
        : { state: 'missing', text: 'Not set: required before a project with several journeys can be published.' };
    }
    case 'interpretationPolicy':
      return customised
        ? { state: 'set', text: `Customised: ${words(keysOf(value))}.` }
        : { state: 'defaults', text: 'Built-in defaults: nothing to set unless you want to change how money, quantities and wording are read.' };
    case 'dialoguePolicy':
      return customised
        ? { state: 'set', text: `Customised: ${words(keysOf(value))}.` }
        : { state: 'defaults', text: 'Built-in defaults: it asks only when a question helps, recommends when it is sure, and otherwise shows a short list.' };
    case 'workspacePinPolicy': {
      const hours = isObject(value) ? value.idleRepinAfterHours : undefined;
      return typeof hours === 'number'
        ? { state: 'set', text: `Set: a conversation idle for ${hours} hour${hours === 1 ? '' : 's'} moves to the live release when it can.` }
        : { state: 'defaults', text: 'Off: every conversation stays on the release it started with.' };
    }
  }
}
