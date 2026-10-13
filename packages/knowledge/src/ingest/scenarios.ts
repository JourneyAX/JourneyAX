import { z } from 'zod';
import type { OkfAcceptanceScenario, OkfDraftContent } from '../contracts';
import { normalizePhrase } from './slug';

/**
 * Customer paths a tenant states as expectations. They are written in the tenant's words (concept *names*, fact keys) and
 * resolved against the draft, then attached as acceptance scenarios: the publication gate runs them, so a release that
 * breaks a stated customer path cannot be published.
 */

const Fact = z.union([z.string(), z.number(), z.boolean()]);
const Mode = z.enum([
  'direct_results', 'overview_then_ask', 'clarify_then_search', 'safety_then_diagnose', 'project_journey', 'evidence_answer',
  'operational_journey', 'service_intake', 'legacy_search', 'no_match', 'knowledge_unavailable',
]);

const ScenarioSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/i),
  description: z.string().min(3).max(300),
  message: z.string().min(1).max(500),
  facts: z.record(z.string(), Fact).optional(),
  forceShow: z.boolean().optional(),
  expect: z.object({
    mode: Mode.optional(),
    /** A concept's name, resolved against the draft. */
    concept: z.string().min(1).optional(),
    retrieval: z.enum(['allowed', 'blocked']).optional(),
    recommendation: z.enum(['blocked', 'category_examples', 'matched_to_stated_needs', 'verified_recommendation']).optional(),
    ask: z.string().min(1).optional(),
    noAsk: z.boolean().optional(),
    claimsExcluded: z.array(z.string()).optional(),
    claimsIncluded: z.array(z.string()).optional(),
    commerce: z.object({
      addToCart: z.enum(['allowed', 'allowed_with_warning', 'blocked']).optional(),
      checkout: z.enum(['allowed', 'requires_compatibility_resolution', 'requires_professional_confirmation', 'blocked']).optional(),
    }).strict().optional(),
    reasonCodes: z.array(z.string().min(1)).optional(),
    /** Concept names that must be among the "Have you considered?" suggestions. */
    suggests: z.array(z.string().min(1)).optional(),
    noSuggestions: z.boolean().optional(),
  }).strict(),
}).strict();

export const ScenarioFileSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  scenarios: z.array(ScenarioSchema).min(1).max(500),
  /** Concept names a person has reviewed as reading like a safety, operational or evidence phrase; reaching them in words may escalate or ask. */
  acceptedRoutingCollisions: z.array(z.string().min(1)).default([]),
}).strict();
export type ScenarioFile = z.infer<typeof ScenarioFileSchema>;

export interface ScenarioError { code: 'unknown_concept' | 'ambiguous_concept' | 'duplicate_scenario' | 'unknown_fact'; where: string; message: string }

/** Resolves a scenario file against a draft. Unresolvable references are errors, never silently dropped. */
export function attachAcceptanceScenarios(draft: OkfDraftContent, fileInput: unknown): { scenarios: OkfAcceptanceScenario[]; errors: ScenarioError[] } {
  const file = ScenarioFileSchema.parse(fileInput);
  const errors: ScenarioError[] = [];
  const byName = new Map<string, string[]>();
  for (const concept of draft.concepts as any[]) {
    const key = normalizePhrase(concept.name);
    byName.set(key, [...(byName.get(key) ?? []), concept.conceptId]);
  }
  const facts = new Set((draft.factRegistry as any[]).map((fact) => fact.factKey));
  const seen = new Set<string>();
  const resolve = (name: string, where: string): string | undefined => {
    const found = byName.get(normalizePhrase(name)) ?? [];
    if (found.length === 0) { errors.push({ code: 'unknown_concept', where, message: `no concept is named '${name}'` }); return undefined; }
    if (found.length > 1) { errors.push({ code: 'ambiguous_concept', where, message: `'${name}' names ${found.length} concepts` }); return undefined; }
    return found[0];
  };
  const scenarios: OkfAcceptanceScenario[] = [];
  for (const scenario of file.scenarios) {
    const where = `scenarios.${scenario.id}`;
    if (seen.has(scenario.id)) errors.push({ code: 'duplicate_scenario', where, message: 'scenario ids must be unique' });
    seen.add(scenario.id);
    for (const key of [...Object.keys(scenario.facts ?? {}), ...(scenario.expect.ask ? [scenario.expect.ask] : [])]) {
      if (!facts.has(key)) errors.push({ code: 'unknown_fact', where, message: `'${key}' is not a fact of this release` });
    }
    const e = scenario.expect;
    const conceptId = e.concept ? resolve(e.concept, `${where}.expect.concept`) : undefined;
    const suggests = (e.suggests ?? []).map((name, index) => resolve(name, `${where}.expect.suggests[${index}]`)).filter((id): id is string => Boolean(id));
    scenarios.push({
      scenarioId: scenario.id, description: scenario.description, message: scenario.message,
      ...(scenario.facts ? { knownFacts: scenario.facts } : {}), ...(scenario.forceShow ? { forceShowResults: true } : {}),
      expect: {
        ...(e.mode ? { mode: e.mode } : {}), ...(conceptId ? { conceptId } : {}), ...(e.retrieval ? { retrievalPermission: e.retrieval } : {}),
        ...(e.recommendation ? { recommendation: e.recommendation } : {}), ...(e.ask ? { clarificationFactKey: e.ask } : {}), ...(e.noAsk ? { noClarification: true } : {}),
        ...(e.claimsExcluded ? { claimsExcluded: e.claimsExcluded as any } : {}), ...(e.claimsIncluded ? { claimsIncluded: e.claimsIncluded as any } : {}),
        ...(e.commerce ? { commerce: e.commerce } : {}), ...(e.reasonCodes ? { reasonCodesInclude: e.reasonCodes } : {}),
        ...(suggests.length ? { suggestsConceptIds: suggests } : {}), ...(e.noSuggestions ? { noSuggestions: true } : {}),
      },
    } as OkfAcceptanceScenario);
  }
  return { scenarios, errors };
}
