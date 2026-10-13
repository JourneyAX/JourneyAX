import { createHash } from 'node:crypto';
import { z } from 'zod';
import { computeKnowledgeEntityHash, stableKnowledgeJson } from '../checksum';
import type { OkfDraftContent } from '../contracts';
import type { GeneratedKnowledge } from './build-draft';
import { GENERATOR, PROVENANCE_KEY, type Provenance, type ProvenanceMap } from './types';
import { normalizePhrase, slugify } from './slug';
import { nodeScope, type TaxonomyNode } from './taxonomy';
import { mergeSearchScopes } from '../category-scope';

/**
 * Authoring layer. A tenant-reviewed specification adds the parts a catalogue cannot know — families of categories,
 * projects, problems, care topics, risk policy and "have you considered" suggestions — on top of the generated draft.
 *
 * Guard rails built into the schema, not left to convention:
 *  - authored relationships are limited to non-claim types: no compatibility, requirement or substitution can be
 *    authored without a source, because there is no field to author it with
 *  - risk and commerce overlays can only tighten what exists
 *  - a problem has no safety steps and a care topic has no instructions: guidance enters only through verification
 *  - everything authored is a `authored_proposal`, never verified
 */

const Id = z.string().regex(/^[a-z][a-z0-9_]*$/);
const Ref = z.string().min(1).max(200);
const Text = z.string().min(1).max(400);
const Phrases = z.array(z.string().min(2).max(120)).max(60).default([]);

const FactSchema = z.object({
  factKey: Id,
  question: z.string().min(3).max(300),
  uiInputType: z.enum(['text', 'select', 'multi_select', 'number', 'slider', 'boolean_toggle', 'card_choice']).default('card_choice'),
  type: z.enum(['string', 'number', 'boolean', 'enum', 'array']).default('enum'),
  options: z.array(z.object({ value: z.string().min(1), label: z.string().min(1) }).strict()).max(30).optional(),
  role: z.enum(['measurement', 'money', 'quantity']).optional(),
}).strict();

const FamilySchema = z.object({
  id: Id, name: Text, description: Text, synonyms: Phrases, phrases: Phrases,
  members: z.array(Ref).min(2).max(40),
  /** Asks this authored fact; each answer routes to a member. Without it a navigation question lists the members. */
  discriminator: z.object({ fact: Id, valueMap: z.record(z.string(), Ref) }).strict().optional(),
  question: z.string().min(3).max(300).optional(),
  compatibilitySensitive: z.boolean().default(false),
}).strict();

const ProjectSchema = z.object({
  id: Id, name: Text, description: Text, synonyms: Phrases, phrases: Phrases,
  /** A journey of the active Business Pack that owns this project's flow; without one the gate serves it directly. */
  journey: z.object({ journeyId: z.string().min(1), entryStageId: z.string().min(1).optional() }).strict().optional(),
  /** Questions asked, in order, before products are shown. */
  facts: z.array(z.object({ fact: Id, importance: z.enum(['high', 'medium', 'low']).default('medium') }).strict()).max(10).default([]),
  categories: z.array(Ref).min(1).max(40),
  overviewGroups: z.number().int().min(1).max(10).optional(),
  /** Optional merchant choice: an answered fact narrows the preview to these member categories. */
  categorySelection: z.object({
    fact: Id,
    valueMap: z.record(z.string(), z.array(Ref).min(1).max(10)),
  }).strict().optional(),
}).strict();

const ProblemSchema = z.object({
  id: Id, name: Text, description: Text, synonyms: Phrases, phrases: Phrases,
  /** Facts worth asking once guidance exists (for example where the leak is). */
  facts: z.array(Id).max(5).default([]),
}).strict();

const CareSchema = z.object({
  id: Id, name: Text, description: Text, synonyms: Phrases, phrases: Phrases,
  appliesTo: z.array(Ref).min(1).max(40),
}).strict();

const RANK = {
  riskClass: { standard: 0, compatibility: 1, safety_critical: 2 },
  addToCart: { allowed: 0, allowed_with_warning: 1, blocked: 2 },
  checkout: { allowed: 0, requires_compatibility_resolution: 1, requires_professional_confirmation: 2, blocked: 3 },
} as const;

const OverlaySchema = z.object({
  id: Id,
  /** Why the merchant would want this; shown to the reviewer. Not a claim about the product. */
  reason: Text,
  match: z.object({ categories: z.array(Ref).default([]), departments: z.array(Ref).default([]) }).strict()
    .refine((match) => match.categories.length + match.departments.length > 0, 'a match is required'),
  set: z.object({
    // safety_critical is for emergency/problem concepts that must never retrieve products; a product category asks for
    // professional confirmation through the checkout policy instead.
    riskClass: z.literal('compatibility').optional(),
    compatibilitySensitive: z.literal(true).optional(),
    addToCart: z.enum(['allowed_with_warning', 'blocked']).optional(),
    checkout: z.enum(['requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']).optional(),
  }).strict().refine((set) => Object.keys(set).length > 0, 'a change is required'),
}).strict();

const SuggestionSchema = z.object({
  id: Id, from: Ref, to: z.array(Ref).min(1).max(12), rationale: Text, label: z.string().min(3).max(80).optional(),
}).strict();

/** Words customers use for a category that already exists ("gib" for plasterboard). They add customer phrases to that concept and nothing else. */
const AliasSchema = z.object({
  id: Id,
  /** The existing category, or group, these words mean. */
  concept: Ref,
  phrases: z.array(Text).min(1).max(30),
  /** Why a customer says it this way; shown to the reviewer. Not a claim about a product. */
  reason: Text,
}).strict();

export const AuthoringSpecSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  author: z.object({ model: z.string().min(1), role: z.string().min(1) }).strict(),
  journeyTargets: z.array(z.object({ journeyId: z.string().min(1) }).strict()).default([]),
  facts: z.array(FactSchema).default([]),
  families: z.array(FamilySchema).default([]),
  projects: z.array(ProjectSchema).default([]),
  problems: z.array(ProblemSchema).default([]),
  care: z.array(CareSchema).default([]),
  overlays: z.array(OverlaySchema).default([]),
  aliases: z.array(AliasSchema).default([]),
  suggestions: z.array(SuggestionSchema).default([]),
  /** Which kinds of crawled document could, once verified, support which claim class. */
  evidence: z.object({ kinds: z.record(z.string(), z.array(z.string().min(1)).min(1)) }).strict(),
}).strict();
export type AuthoringSpec = z.infer<typeof AuthoringSpecSchema>;

export interface AuthoringError { code: string; where: string; message: string }

export interface WorklistEntry {
  conceptId: string;
  conceptName: string;
  department: string;
  claimClass: string;
  status: 'unverified';
  needs: 'applicable_manufacturer_document_or_qualified_human';
  candidates: Array<{ title: string; url: string; kind: string; sku?: string }>;
  /** What stays switched off for customers until this is verified. */
  blocks: string;
}
export interface WorklistGap { conceptId: string; conceptName: string; claimClass: string; reason: string }

export interface AuthoredKnowledge extends GeneratedKnowledge {
  spec: AuthoringSpec;
  errors: AuthoringError[];
  authored: { facts: number; families: number; projects: number; problems: number; care: number; overlays: number; aliases: number; suggestions: number; removedDerivedPhrases: number; concepts: number; relationships: number };
  worklist: { entries: WorklistEntry[]; gaps: WorklistGap[] };
  /** Journeys referenced by projects that the active pack does not declare, or projects with no journey at all. */
  projectsWithoutJourney: string[];
}

const SOURCE_ID = 'src-authoring-proposal';
const BLOCKS: Record<string, string> = {
  installation_step: 'installation answers', warranty: 'warranty answers', care_safety: 'care guidance',
  safety_instruction: 'safety guidance', compatibility: 'compatibility statements', requirement: 'requirement statements',
};

const mark = (snapshotAt: string, detail: Record<string, unknown>): Provenance => ({
  kind: 'authored_proposal', generator: GENERATOR, snapshotAt, verified: false, detail,
});

/** Resolves a category reference ("Name", "Group > Name", "Department > Group > Name") to exactly one taxonomy node. */
function makeResolver(generated: GeneratedKnowledge, errors: AuthoringError[]) {
  const nodes = generated.tree.nodes.filter((node) => node.status === 'concept');
  return (ref: string, where: string): TaxonomyNode | undefined => {
    const wanted = ref.split('>').map((part) => normalizePhrase(part));
    const matches = nodes.filter((node) => {
      const path = node.path.map(normalizePhrase);
      if (path.length < wanted.length) return false;
      return wanted.every((segment, index) => path[path.length - wanted.length + index] === segment) || node.identifiers.some((id) => wanted.length === 1 && normalizePhrase(id) === wanted[0]);
    });
    const unique = [...new Set(matches)];
    if (unique.length === 1) return unique[0];
    if (unique.length === 0) errors.push({ code: 'unresolved_ref', where, message: `'${ref}' matches no category` });
    else errors.push({ code: 'ambiguous_ref', where, message: `'${ref}' matches ${unique.length} categories; qualify it: ${unique.map((node) => node.path.join(' > ')).slice(0, 6).join(' | ')}` });
    return undefined;
  };
}

const hashOf = <T extends Record<string, any>>(value: T): T & { contentHash: string } => ({ ...value, contentHash: computeKnowledgeEntityHash(value) });
/** Recomputes the hash of an edited entity, ignoring whatever hash it carried. */
const rehash = (value: Record<string, any>): Record<string, any> => {
  const { contentHash: _previous, ...rest } = value;
  return hashOf(rest);
};

export function applyAuthoring(generated: GeneratedKnowledge, specInput: unknown): AuthoredKnowledge {
  const spec = AuthoringSpecSchema.parse(specInput);
  if (spec.tenantId !== generated.config.tenantId) throw new Error(`Authoring spec tenant '${spec.tenantId}' does not match '${generated.config.tenantId}'`);
  const errors: AuthoringError[] = [];
  const snapshotAt = generated.snapshot.snapshotAt;
  const tenant = spec.tenantId;
  const draft = structuredClone(generated.draft) as any;
  const resolve = makeResolver(generated, errors);
  const byId = new Map<string, any>(draft.concepts.map((concept: any) => [concept.conceptId, concept]));
  const conceptOf = (node: TaxonomyNode) => byId.get(generated.conceptIdByNode.get(node)!);
  const touched = new Set<any>();

  // ── Authored source and facts ──
  draft.sources.push({
    sourceId: SOURCE_ID, kind: 'llm_draft', title: `Authoring proposal ${spec.version} (${spec.author.role}; awaiting merchant review)`,
    model: spec.author.model, promptHash: createHash('sha256').update(stableKnowledgeJson(spec)).digest('hex'), generatedAt: snapshotAt,
  });
  const factKeys = new Set<string>(draft.factRegistry.map((fact: any) => fact.factKey));
  const authoredFacts = new Map(spec.facts.map((fact) => [fact.factKey, fact] as const));
  for (const fact of spec.facts) {
    if (factKeys.has(fact.factKey)) { errors.push({ code: 'duplicate_fact', where: `facts.${fact.factKey}`, message: 'a fact with this key already exists' }); continue; }
    if ((fact.type === 'enum' || fact.type === 'array') && !fact.options?.length) {
      errors.push({ code: 'fact_options_required', where: `facts.${fact.factKey}`, message: 'a choice fact needs options' }); continue;
    }
    factKeys.add(fact.factKey);
    draft.factRegistry.push({
      factKey: fact.factKey, type: fact.type, questionRef: `q.${fact.factKey}`, question: fact.question, uiInputType: fact.uiInputType,
      ...(fact.options ? { options: fact.options } : {}),
      extensions: { ...(fact.role ? { role: fact.role } : {}), ...(fact.type === 'array' ? { multiple: true } : {}), [PROVENANCE_KEY]: { structure: mark(snapshotAt, { section: 'facts' }) } },
    });
  }
  const requireFact = (factKey: string, where: string) => {
    if (!factKeys.has(factKey)) errors.push({ code: 'unknown_fact', where, message: `fact '${factKey}' is not defined` });
  };

  const relationships: any[] = draft.relationships;
  const addRelationship = ({ __section, ...relationship }: Record<string, any>) => relationships.push(hashOf({
    strength: 'optional', scope: 'category', confidence: 'low', claimClasses: [], sourceRefs: [SOURCE_ID], ...relationship,
    extensions: { [PROVENANCE_KEY]: { structure: mark(snapshotAt, { section: __section ?? 'authoring' }) } },
  }));
  const baseConcept = (id: string, section: string, over: Record<string, any>) => {
    const conceptId = `concept://${tenant}/${section}/${id.replace(/_/g, '-')}`;
    if (byId.has(conceptId)) errors.push({ code: 'duplicate_concept', where: `${section}.${id}`, message: 'concept id already exists' });
    return {
      conceptId, tenantId: tenant, synonyms: [], customerPhrases: [], requiredFacts: [], discriminators: [],
      searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
      commercePolicy: { ...generated.config.commerce }, safety: { blocksProducts: false, stepRefs: [] },
      riskClass: 'standard', compatibilitySensitive: false, evidenceRefs: [SOURCE_ID], lifecycle: { status: 'active_draft' }, version: 1,
      ...over,
    };
  };
  const finish = (concept: any, section: string, extra: ProvenanceMap = {}) => {
    concept.extensions = { [PROVENANCE_KEY]: { structure: mark(snapshotAt, { section, id: concept.conceptId.split('/').pop() }), ...extra } };
    const done = hashOf(concept);
    byId.set(done.conceptId, done);
    draft.concepts.push(done);
    return done;
  };
  /** The union of several scopes; hierarchy paths are kept as paths so a family never degrades to by-name matching. */
  const unionScope = (scopes: Array<{ catalogCategoryIds: string[]; catalogCategoryPaths?: string[][] }>) => {
    const merged = mergeSearchScopes(scopes);
    return {
      catalogCategoryIds: merged.categoryIds,
      ...(merged.categoryPaths.length ? { catalogCategoryPaths: merged.categoryPaths } : {}),
      enrichmentFacets: [] as string[], excludeCategoryIds: [] as string[],
    };
  };
  const authoredIds = new Map<string, string>(); // "family:id" → concept id

  // ── Families: a customer word that names several categories ──
  for (const family of spec.families) {
    const where = `families.${family.id}`;
    const members = family.members.map((ref) => resolve(ref, where)).filter((node): node is TaxonomyNode => Boolean(node));
    if (members.length !== family.members.length) continue;
    const memberConcepts = members.map(conceptOf);
    let discriminators: any[] = [];
    let requiredFacts: any[] = [];
    if (family.discriminator) {
      requireFact(family.discriminator.fact, `${where}.discriminator`);
      const valueMap: Record<string, string> = {};
      for (const [value, ref] of Object.entries(family.discriminator.valueMap)) {
        const node = resolve(ref, `${where}.discriminator.${value}`);
        if (node) valueMap[value] = generated.conceptIdByNode.get(node)!;
      }
      discriminators = [{ factKey: family.discriminator.fact, questionRef: `q.${family.discriminator.fact}`, clarifyFirst: false, valueMap }];
      requiredFacts = [{ factKey: family.discriminator.fact, importance: 'medium' }];
    } else {
      const factKey = `nav_family_${family.id}`;
      draft.factRegistry.push({
        factKey, type: 'enum', questionRef: `q.${factKey}`, uiInputType: generated.config.navigation.uiInputType,
        question: family.question ?? generated.config.navigation.questionTemplate.replace('{name}', family.name),
        options: members.slice(0, generated.config.navigation.maxOptions).map((node) => ({ value: node.slug, label: node.name })),
        extensions: { [PROVENANCE_KEY]: { structure: mark(snapshotAt, { section: 'families', navigation: true }) } },
      });
      factKeys.add(factKey);
      discriminators = [{ factKey, questionRef: `q.${factKey}`, clarifyFirst: false, valueMap: Object.fromEntries(members.map((node) => [node.slug, generated.conceptIdByNode.get(node)!])) }];
      requiredFacts = [{ factKey, importance: 'medium' }];
    }
    const concept = finish(baseConcept(family.id, 'families', {
      type: 'product_family', lens: 'product', name: family.name, description: family.description,
      synonyms: family.synonyms, customerPhrases: family.phrases, requiredFacts, discriminators,
      compatibilitySensitive: family.compatibilitySensitive, riskClass: family.compatibilitySensitive ? 'compatibility' : 'standard',
      searchScope: unionScope(members.map(nodeScope)),
      broadQueryPolicy: {
        groupConceptIds: memberConcepts.slice(0, generated.config.navigation.overviewGroups).map((c: any) => c.conceptId),
        maxItemsPerGroup: generated.config.navigation.maxItemsPerGroup, questionRef: discriminators[0].questionRef, productRetrievalAllowed: true,
      },
    }), 'families');
    authoredIds.set(`family:${family.id}`, concept.conceptId);
    for (const member of memberConcepts) addRelationship({ relationshipId: `rel-family-${family.id}-${slugify(member.name)}`, from: member.conceptId, to: concept.conceptId, type: 'child_of', confidence: 'medium', __section: 'families' });
  }

  const refToNodesAndConcepts = (ref: string, where: string): { nodes: TaxonomyNode[]; conceptId?: string } => {
    if (/^(family|project|problem|care):/.test(ref)) {
      const conceptId = authoredIds.get(ref);
      if (!conceptId) { errors.push({ code: 'unresolved_ref', where, message: `${ref} is not an authored ${ref.split(':')[0]}` }); return { nodes: [] }; }
      return { nodes: [], conceptId };
    }
    const node = resolve(ref, where);
    return node ? { nodes: [node], conceptId: generated.conceptIdByNode.get(node) } : { nodes: [] };
  };
  const scopeOfConcept = (conceptId: string) => (byId.get(conceptId)?.searchScope ?? { catalogCategoryIds: [] }) as { catalogCategoryIds: string[]; catalogCategoryPaths?: string[][] };

  // ── Projects ──
  const projectsWithoutJourney: string[] = [];
  const journeyIds = new Set(spec.journeyTargets.map((target) => target.journeyId));
  for (const project of spec.projects) {
    const where = `projects.${project.id}`;
    if (project.journey && !journeyIds.has(project.journey.journeyId)) {
      errors.push({ code: 'unknown_journey', where, message: `journey '${project.journey.journeyId}' is not a declared target of the active pack` });
    }
    if (!project.journey) projectsWithoutJourney.push(project.id);
    project.facts.forEach((entry) => requireFact(entry.fact, `${where}.facts`));
    const members = project.categories.map((ref, index) => refToNodesAndConcepts(ref, `${where}.categories[${index}]`)).filter((entry) => entry.conceptId);
    const memberIds = members.map((entry) => entry.conceptId!);
    let groupSelection: { factKey: string; valueMap: Record<string, string[]> } | undefined;
    if (project.categorySelection) {
      const { fact, valueMap } = project.categorySelection;
      requireFact(fact, `${where}.categorySelection.fact`);
      if (!project.facts.some((entry) => entry.fact === fact)) {
        errors.push({ code: 'undeclared_selection_fact', where, message: `category selection fact '${fact}' must be a project question` });
      }
      const allowedValues = new Set(authoredFacts.get(fact)?.options?.map((option) => option.value) ?? []);
      const resolved: Record<string, string[]> = {};
      for (const [value, refs] of Object.entries(valueMap)) {
        if (!allowedValues.has(value)) {
          errors.push({ code: 'unknown_selection_value', where, message: `'${value}' is not an option of '${fact}'` });
        }
        resolved[value] = refs.flatMap((ref) => {
          const target = refToNodesAndConcepts(ref, `${where}.categorySelection.${value}`);
          if (target.conceptId && !memberIds.includes(target.conceptId)) {
            errors.push({ code: 'selection_outside_project', where, message: `'${ref}' is not a category of this project` });
          }
          return target.conceptId && memberIds.includes(target.conceptId) ? [target.conceptId] : [];
        });
      }
      groupSelection = { factKey: fact, valueMap: resolved };
    }
    const concept = finish(baseConcept(project.id, 'projects', {
      type: 'project', lens: 'project', name: project.name, description: project.description,
      synonyms: project.synonyms, customerPhrases: project.phrases,
      ...(project.journey ? { journeyRef: project.journey } : {}),
      requiredFacts: project.facts.map((entry) => ({ factKey: entry.fact, importance: entry.importance })),
      discriminators: project.facts.map((entry) => ({ factKey: entry.fact, questionRef: `q.${entry.fact}`, clarifyFirst: false, valueMap: {} })),
      searchScope: unionScope(memberIds.map(scopeOfConcept)),
      broadQueryPolicy: {
        groupConceptIds: memberIds.slice(0, project.overviewGroups ?? generated.config.navigation.overviewGroups),
        maxItemsPerGroup: generated.config.navigation.maxItemsPerGroup, ...(project.facts[0] ? { questionRef: `q.${project.facts[0].fact}` } : {}), productRetrievalAllowed: true,
        ...(groupSelection ? { groupSelection } : {}),
      },
    }), 'projects');
    authoredIds.set(`project:${project.id}`, concept.conceptId);
  }

  // ── Problems: structure only; guidance can only arrive through verification ──
  for (const problem of spec.problems) {
    problem.facts.forEach((fact) => requireFact(fact, `problems.${problem.id}.facts`));
    const concept = finish(baseConcept(problem.id, 'problems', {
      type: 'symptom', lens: 'problem', name: problem.name, description: problem.description,
      synonyms: problem.synonyms, customerPhrases: problem.phrases, riskClass: 'safety_critical',
      requiredFacts: problem.facts.map((fact) => ({ factKey: fact, importance: 'high' })),
      commercePolicy: { addToCart: 'blocked', checkout: 'blocked' }, safety: { blocksProducts: true, stepRefs: [] },
    }), 'problems');
    authoredIds.set(`problem:${problem.id}`, concept.conceptId);
  }

  // ── Care topics: relationships stay unverified, so no care claim can be made yet ──
  for (const care of spec.care) {
    const where = `care.${care.id}`;
    const targets = care.appliesTo.map((ref, index) => refToNodesAndConcepts(ref, `${where}.appliesTo[${index}]`)).filter((entry) => entry.conceptId);
    const concept = finish(baseConcept(care.id, 'care', {
      type: 'care', lens: 'care', name: care.name, description: care.description, synonyms: care.synonyms, customerPhrases: care.phrases,
      searchScope: unionScope(targets.map((entry) => scopeOfConcept(entry.conceptId!))),
    }), 'care');
    authoredIds.set(`care:${care.id}`, concept.conceptId);
    for (const target of targets) {
      addRelationship({
        relationshipId: `rel-care-${care.id}-${slugify(target.conceptId!.split('/').slice(2).join('-'))}`, from: concept.conceptId, to: target.conceptId!,
        type: 'care_for', strength: 'recommended', claimClasses: ['care_safety'], __section: 'care',
      });
    }
  }

  // ── Overlays: only ever tighter ──
  const tighten = (concept: any, overlay: z.infer<typeof OverlaySchema>) => {
    const next = { ...concept, commercePolicy: { ...concept.commercePolicy }, safety: { ...concept.safety } };
    const { set } = overlay;
    if (set.riskClass && RANK.riskClass[set.riskClass] > RANK.riskClass[concept.riskClass as keyof typeof RANK.riskClass]) next.riskClass = set.riskClass;
    if (set.compatibilitySensitive) next.compatibilitySensitive = true;
    if (set.addToCart && RANK.addToCart[set.addToCart] > RANK.addToCart[concept.commercePolicy.addToCart as keyof typeof RANK.addToCart]) next.commercePolicy.addToCart = set.addToCart;
    if (set.checkout && RANK.checkout[set.checkout] > RANK.checkout[concept.commercePolicy.checkout as keyof typeof RANK.checkout]) next.commercePolicy.checkout = set.checkout;
    return next;
  };
  for (const overlay of spec.overlays) {
    const where = `overlays.${overlay.id}`;
    const targets = new Set<TaxonomyNode>();
    for (const ref of overlay.match.categories) { const node = resolve(ref, `${where}.match.categories`); if (node) targets.add(node); }
    for (const ref of overlay.match.departments) {
      const node = resolve(ref, `${where}.match.departments`);
      if (node) { const walk = (n: TaxonomyNode) => { targets.add(n); n.children.forEach(walk); }; walk(node); }
    }
    for (const node of targets) {
      const current = conceptOf(node);
      if (!current) continue;
      const tightened = tighten(current, overlay);
      tightened.extensions = { [PROVENANCE_KEY]: { ...(current.extensions?.[PROVENANCE_KEY] ?? {}), [`policy_${overlay.id}`]: mark(snapshotAt, { section: 'overlays', overlay: overlay.id, reason: overlay.reason }) } };
      const index = draft.concepts.indexOf(current);
      const done = rehash(tightened);
      draft.concepts[index] = done;
      byId.set(done.conceptId, done);
      touched.add(done);
    }
  }

  // ── Cross-sell suggestions ("Have you considered?"): unverified, never a claim ──
  for (const suggestion of spec.suggestions) {
    const where = `suggestions.${suggestion.id}`;
    const from = refToNodesAndConcepts(suggestion.from, `${where}.from`);
    if (!from.conceptId) continue;
    suggestion.to.forEach((ref, index) => {
      const to = refToNodesAndConcepts(ref, `${where}.to[${index}]`);
      if (!to.conceptId) return;
      if (to.conceptId === from.conceptId) { errors.push({ code: 'self_suggestion', where, message: 'a concept cannot suggest itself' }); return; }
      addRelationship({
        relationshipId: `rel-xs-${suggestion.id}-${index + 1}`, from: from.conceptId, to: to.conceptId, type: 'cross_sell',
        ...(suggestion.label ? { customerLabel: suggestion.label } : {}), __section: 'suggestions',
      });
    });
  }

  // ── Aliases: the words customers use for a category that already exists ──
  // They add customer phrases to that concept (marked as an authored proposal) and nothing else: no claim, no commerce change.
  const aliasOwner = new Map<string, string>();
  for (const alias of spec.aliases) {
    const where = `aliases.${alias.id}`;
    const node = resolve(alias.concept, `${where}.concept`);
    const current = node ? conceptOf(node) : undefined;
    if (!current) continue;
    const phrases = alias.phrases.map(normalizePhrase).filter(Boolean);
    for (const phrase of phrases) {
      const holder = aliasOwner.get(phrase);
      if (holder && holder !== current.conceptId) errors.push({ code: 'ambiguous_alias', where, message: `'${phrase}' is already an alias of ${holder}` });
      else aliasOwner.set(phrase, current.conceptId);
    }
    const customerPhrases = [...new Set([...current.customerPhrases, ...phrases])];
    const next = rehash({
      ...current, customerPhrases,
      extensions: { ...(current.extensions ?? {}), [PROVENANCE_KEY]: { ...(current.extensions?.[PROVENANCE_KEY] ?? {}), [`alias_${alias.id}`]: mark(snapshotAt, { section: 'aliases', alias: alias.id, reason: alias.reason }) } },
    });
    draft.concepts[draft.concepts.indexOf(current)] = next;
    byId.set(next.conceptId, next);
    touched.add(next);
  }

  // ── Phrase ownership: an authored phrase beats a derived one; two authored concepts may not share one ──
  const authoredConceptIds = new Set(authoredIds.values());
  const owner = new Map<string, string>();
  for (const concept of draft.concepts.filter((entry: any) => authoredConceptIds.has(entry.conceptId))) {
    for (const phrase of [concept.name, ...concept.synonyms, ...concept.customerPhrases].map(normalizePhrase)) {
      const existing = owner.get(phrase);
      if (existing && existing !== concept.conceptId) errors.push({ code: 'ambiguous_phrase', where: concept.conceptId, message: `'${phrase}' is also claimed by ${existing}` });
      owner.set(phrase, concept.conceptId);
    }
  }
  // A derived concept's NAME is how customers reach it; an authored phrase may not shadow it.
  for (const concept of draft.concepts.filter((entry: any) => !authoredConceptIds.has(entry.conceptId))) {
    const holder = owner.get(normalizePhrase(concept.name));
    if (holder) errors.push({ code: 'phrase_collides_with_name', where: holder, message: `'${concept.name}' is the name of ${concept.conceptId}` });
    const aliasHolder = aliasOwner.get(normalizePhrase(concept.name));
    if (aliasHolder && aliasHolder !== concept.conceptId) errors.push({ code: 'phrase_collides_with_name', where: aliasHolder, message: `alias '${concept.name}' is the name of ${concept.conceptId}` });
  }
  for (const [phrase, holder] of aliasOwner) {
    if (owner.has(phrase) && owner.get(phrase) !== holder) errors.push({ code: 'ambiguous_phrase', where: holder, message: `alias '${phrase}' is also claimed by ${owner.get(phrase)}` });
  }
  let removed = 0;
  draft.concepts = draft.concepts.map((concept: any) => {
    if (authoredConceptIds.has(concept.conceptId)) return concept;
    // A derived phrase is dropped when an authored concept owns it, or when it is another concept's alias.
    const keep = (phrase: string) => !owner.has(normalizePhrase(phrase)) && (aliasOwner.get(normalizePhrase(phrase)) ?? concept.conceptId) === concept.conceptId;
    const synonyms = concept.synonyms.filter(keep);
    const customerPhrases = concept.customerPhrases.filter(keep);
    const dropped = concept.synonyms.length - synonyms.length + concept.customerPhrases.length - customerPhrases.length;
    if (dropped === 0) return concept;
    removed += dropped;
    const next = rehash({ ...concept, synonyms, customerPhrases });
    byId.set(next.conceptId, next);
    return next;
  });

  // ── Worklist: which claims could be verified, from which candidate documents ──
  const kindToClaim = new Map<string, string>();
  for (const [claimClass, kinds] of Object.entries(spec.evidence.kinds)) for (const kind of kinds) kindToClaim.set(kind, claimClass);
  const entries: WorklistEntry[] = [];
  const gaps: WorklistGap[] = [];
  const departmentOf = (node: TaxonomyNode) => node.path[0];
  for (const node of generated.tree.nodes.filter((entry) => entry.status === 'concept')) {
    const concept = byId.get(generated.conceptIdByNode.get(node)!);
    const isLeaf = node.children.length === 0;
    const docs = generated.snapshot.documentCandidates.filter((doc) => isLeaf
      ? doc.path.length === node.path.length && doc.path.every((segment, index) => segment === node.path[index])
      : false);
    const byClaim = new Map<string, typeof docs>();
    for (const doc of docs) {
      const claim = kindToClaim.get(doc.kind);
      if (claim) byClaim.set(claim, [...(byClaim.get(claim) || []), doc]);
    }
    for (const [claimClass, list] of byClaim) {
      entries.push({
        conceptId: concept.conceptId, conceptName: concept.name, department: departmentOf(node), claimClass, status: 'unverified',
        needs: 'applicable_manufacturer_document_or_qualified_human', blocks: BLOCKS[claimClass] ?? claimClass,
        candidates: list.slice(0, 5).map((doc) => ({ title: doc.title, url: doc.sourceUrl, kind: doc.kind, ...(doc.sku ? { sku: doc.sku } : {}) })),
      });
    }
  }
  for (const problem of spec.problems) {
    const conceptId = authoredIds.get(`problem:${problem.id}`);
    if (conceptId) gaps.push({ conceptId, conceptName: problem.name, claimClass: 'safety_instruction', reason: 'No applicable document: needs a qualified person to author and verify the first-response guidance. Customers are referred to a professional until then.' });
  }
  for (const care of spec.care) {
    const conceptId = authoredIds.get(`care:${care.id}`);
    if (conceptId) gaps.push({ conceptId, conceptName: care.name, claimClass: 'care_safety', reason: 'Care instructions need an applicable manufacturer document or a qualified person; the care relationships are unverified.' });
  }

  draft.relationships = relationships;
  const authoredRelationshipCount = draft.relationships.filter((relationship: any) => relationship.extensions?.[PROVENANCE_KEY]?.structure?.kind === 'authored_proposal').length;
  return {
    ...generated,
    draft: draft as OkfDraftContent,
    spec, errors,
    authored: {
      facts: spec.facts.length, families: spec.families.length, projects: spec.projects.length, problems: spec.problems.length, care: spec.care.length,
      overlays: spec.overlays.length, aliases: spec.aliases.length, suggestions: spec.suggestions.length, removedDerivedPhrases: removed,
      concepts: authoredIds.size, relationships: authoredRelationshipCount,
    },
    worklist: { entries, gaps },
    projectsWithoutJourney,
  };
}
