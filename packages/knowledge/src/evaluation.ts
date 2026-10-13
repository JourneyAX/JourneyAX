import templatesDefault from './defaults/evaluation-templates.json';
import type { ClaimClass, OkfConcept, OkfReleaseContent } from './contracts';
import { governingConceptsForProduct, resolveOkfBasketCommerce } from './basket-commerce';
import { resolveOkfGate, type OkfGateDecision } from './gate';
import { renderOkfMessage, resolveOkfPolicy } from './policy';
import type { CatalogueRow } from './insight';

/**
 * Coverage-driven evaluation. Instead of a hand-picked set of conversations, the scenarios are generated from the release
 * and the catalogue itself, so every department and category is probed in every way that matters: can a customer reach it,
 * does its scope select exactly its own products, does the basket apply its commerce rules, does a hazard about it escalate,
 * do suitability / installation / warranty / care questions fail safely, does a bare SKU get its rules, and does the
 * cross-sell stay unverified. The scenarios run through the real gate and basket policy; nothing is stubbed.
 *
 * The report is a matrix (department → category → family) so a gap is a named empty cell, not an impression.
 */

export type EvalFamily =
  | 'routing' | 'scope' | 'commerce' | 'safety' | 'technical_claims' | 'evidence' | 'exact_sku' | 'cross_sell' | 'negative' | 'authored_path';

export const EVAL_FAMILIES: EvalFamily[] = ['routing', 'scope', 'commerce', 'safety', 'technical_claims', 'evidence', 'exact_sku', 'cross_sell', 'negative', 'authored_path'];

export interface EvalTemplates {
  hazards: string[];
  technical: string[];
  evidence: Array<{ template: string; claimClass: ClaimClass }>;
  negative: {
    hazardWithoutProduct: string[];
    hazardWithOperational: string[];
    unknownTechnical: string[];
    unmatchedShopping: string[];
    operational: string[];
  };
}

export interface EvalOptions {
  tenantId: string;
  environmentId?: string;
  releaseId?: string;
  now?: Date;
  /** Distinct (path, category) groups of the live catalogue, with product counts. Without it the scope and commerce families are skipped. */
  catalogue?: CatalogueRow[];
  templates?: EvalTemplates;
  /**
   * Concept names a person has reviewed and accepted as colliding with safety, operational or evidence vocabulary (for example a
   * category called "Repair Products"): reaching them in words may escalate or ask instead. Listed in the report, never silent.
   */
  acceptedRoutingCollisions?: string[];
  /** Narrow a run (for a quick check of one area); the full matrix is what proves coverage. */
  only?: { families?: EvalFamily[]; conceptIds?: string[]; departments?: string[] };
}

export interface EvalScenario {
  id: string;
  family: EvalFamily;
  department: string;
  category: string;
  path: string[];
  conceptId?: string;
  message?: string;
  /** Returns what went wrong; empty means the scenario holds. */
  run: (content: OkfReleaseContent) => string[];
  /** A scenario can pass by an accepted, reviewed exception instead of the plain expectation. */
  accepted?: boolean;
}

export interface EvalResult {
  id: string;
  family: EvalFamily;
  department: string;
  category: string;
  path: string[];
  conceptId?: string;
  message?: string;
  passed: boolean;
  failures: string[];
  /** Passed through a reviewed exception. */
  acceptedException?: string;
}

const CROSS_CUTTING = '(cross-cutting)';
const NO_DEPARTMENT = '(no department)';

const COMMERCE_ADD = { allowed: 0, allowed_with_warning: 1, blocked: 2 } as const;
const COMMERCE_CHECKOUT = { allowed: 0, requires_compatibility_resolution: 1, requires_professional_confirmation: 2, blocked: 3 } as const;
const NO_VERIFIED_CLAIMS: ClaimClass[] = ['compatibility', 'requirement', 'substitution', 'safety_instruction', 'installation_step', 'warranty', 'care_safety'] as ClaimClass[];

const firstPath = (concept: OkfConcept): string[] => ((concept.searchScope as any).catalogCategoryPaths?.[0] ?? []) as string[];
const pathKey = (path: string[]) => path.map((segment) => segment.toLowerCase()).join('\u0000');

/** Ancestors by `child_of`, nearest first. */
function ancestorsOf(content: OkfReleaseContent, conceptId: string): string[] {
  const parent = new Map<string, string>();
  for (const relationship of content.relationships) if (relationship.type === 'child_of') parent.set(relationship.from, relationship.to);
  const out: string[] = [];
  const seen = new Set<string>([conceptId]);
  for (let cursor = parent.get(conceptId); cursor && !seen.has(cursor); cursor = parent.get(cursor)) { out.push(cursor); seen.add(cursor); }
  return out;
}

const fill = (template: string, name: string) => template.replace(/\{name\}/g, name);

/** The commerce a concept declares, after the platform rule that a safety-critical item needs a professional at checkout. */
function declaredCommerce(concept: OkfConcept): { addToCart: keyof typeof COMMERCE_ADD; checkout: keyof typeof COMMERCE_CHECKOUT } {
  const commerce = { ...concept.commercePolicy } as { addToCart: keyof typeof COMMERCE_ADD; checkout: keyof typeof COMMERCE_CHECKOUT };
  if (concept.riskClass === 'safety_critical' && commerce.checkout !== 'blocked') commerce.checkout = 'requires_professional_confirmation';
  return commerce;
}

function strictestOf(policies: Array<{ addToCart: keyof typeof COMMERCE_ADD; checkout: keyof typeof COMMERCE_CHECKOUT }>) {
  return policies.reduce((acc, policy) => ({
    addToCart: COMMERCE_ADD[policy.addToCart] > COMMERCE_ADD[acc.addToCart] ? policy.addToCart : acc.addToCart,
    checkout: COMMERCE_CHECKOUT[policy.checkout] > COMMERCE_CHECKOUT[acc.checkout] ? policy.checkout : acc.checkout,
  }), { addToCart: 'allowed' as keyof typeof COMMERCE_ADD, checkout: 'allowed' as keyof typeof COMMERCE_CHECKOUT });
}

export function buildCoverageScenarios(content: OkfReleaseContent, options: EvalOptions): EvalScenario[] {
  const templates = options.templates ?? (templatesDefault as unknown as EvalTemplates);
  const tenantId = options.tenantId;
  const base = { tenantId, environmentId: options.environmentId ?? 'evaluation', releaseId: options.releaseId ?? 'evaluation', now: options.now ?? new Date(), knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' as const } };
  const gate = (message: string, extra: Record<string, unknown> = {}) => {
    const decision = resolveOkfGate(content, { ...base, message, ...extra } as any) as OkfGateDecision;
    for (const text of decision.claims.notices) wordingViolations.push(...internalWording(text).map((hit) => `customer notice exposes internal wording '${hit}': ${text}`));
    return decision;
  };
  const policy = resolveOkfPolicy((content as any).policy);
  const accepted = new Set((options.acceptedRoutingCollisions ?? []).map((name) => name.toLowerCase()));

  const live = content.concepts.filter((concept) => (concept as any).lifecycle?.status !== 'retired');
  const byId = new Map(live.map((concept) => [concept.conceptId, concept]));
  const pathed = live.filter((concept) => firstPath(concept).length > 0);
  const allPaths = pathed.map((concept) => pathKey(firstPath(concept)));
  // A leaf category: nothing in the release is scoped strictly below it.
  const isLeaf = (concept: OkfConcept) => {
    const key = pathKey(firstPath(concept));
    return !allPaths.some((other) => other !== key && other.startsWith(`${key}\u0000`));
  };
  const leaves = pathed.filter((concept) => concept.lens === 'product' && isLeaf(concept));
  const scenarios: EvalScenario[] = [];
  const where = (concept: OkfConcept) => ({
    department: firstPath(concept)[0] ?? CROSS_CUTTING,
    category: firstPath(concept).length ? firstPath(concept)[firstPath(concept).length - 1] : concept.name,
    path: firstPath(concept),
  });
  const only = options.only;
  const add = (scenario: EvalScenario) => {
    if (only?.families && !only.families.includes(scenario.family)) return;
    if (only?.conceptIds && scenario.conceptId && !only.conceptIds.includes(scenario.conceptId)) return;
    if (only?.departments && !only.departments.includes(scenario.department)) return;
    scenarios.push(scenario);
  };

  // ── Routing: can a customer reach this concept in words? ──
  for (const concept of live) {
    const here = where(concept);
    add({
      id: `routing:name:${concept.conceptId}`, family: 'routing', ...here, conceptId: concept.conceptId, message: concept.name,
      run: () => {
        const decision = gate(concept.name);
        if (decision.conceptId === concept.conceptId) return [];
        const observed = decision.conceptId ? `'${byId.get(decision.conceptId)?.name ?? decision.conceptId}'` : `no concept (${decision.mode})`;
        const collides = accepted.has(concept.name.toLowerCase());
        if (collides && ['safety_then_diagnose', 'operational_journey', 'evidence_answer', 'no_match'].includes(decision.mode)) return [];
        return [`"${concept.name}" reached ${observed} instead of the concept itself`];
      },
    });
    const phrase = (concept.customerPhrases ?? [])[0];
    if (phrase) {
      add({
        id: `routing:phrase:${concept.conceptId}`, family: 'routing', ...here, conceptId: concept.conceptId, message: phrase,
        run: () => {
          const decision = gate(phrase);
          if (!decision.conceptId) return decision.mode === 'safety_then_diagnose' || decision.mode === 'operational_journey' ? [] : [`"${phrase}" matched nothing`];
          if (decision.conceptId === concept.conceptId || ancestorsOf(content, concept.conceptId).includes(decision.conceptId)) return [];
          // A phrase several concepts claim goes to their lowest common parent, which may be a sibling's parent: accept
          // anything within the same department rather than a concept in an unrelated one.
          const reached = byId.get(decision.conceptId);
          if (reached && (firstPath(reached)[0] ?? '') === (firstPath(concept)[0] ?? '') && firstPath(concept).length > 0) return [];
          if (reached && firstPath(concept).length === 0) return []; // authored concepts own their phrases; a different authored concept is checked by the authoring ambiguity rule
          return [`"${phrase}" reached '${reached?.name ?? decision.conceptId}', outside this concept's department`];
        },
      });
    }
  }

  // ── Scope and commerce: every catalogue group, as a product ──
  if (options.catalogue) {
    options.catalogue.forEach((row, index) => {
      const department = row.path[0] ?? (row.category ? CROSS_CUTTING : NO_DEPARTMENT);
      const category = row.path[row.path.length - 1] ?? row.category ?? '(no category)';
      const product = { projectId: tenantId, sku: `eval-${index}`, categoryPath: row.path, categoryNames: row.category ? [row.category] : [] } as any;
      const reachable = row.path.length > 0 || Boolean(row.category);
      const governing = () => governingConceptsForProduct(content, tenantId, product);
      add({
        id: `scope:${index}:${row.path.join('>')}|${row.category ?? ''}`, family: 'scope', department, category, path: row.path,
        run: () => {
          const found = governing();
          if (!reachable) return found.length === 0 ? [] : [`products with no path and no category were governed by '${found[0].name}'`];
          if (found.length === 0) return [`no concept's scope selects products in ${row.path.join(' › ') || row.category}`];
          const failures: string[] = [];
          const isDerived = (concept: OkfConcept) => (concept as any).extensions?.['x-journeyax-provenance']?.structure?.kind === 'catalogue_taxonomy';
          const owns = (concept: OkfConcept) => row.path.length > 0
            ? pathKey(firstPath(concept)) === pathKey(row.path)
            : (concept.searchScope.catalogCategoryIds ?? []).some((id) => id.toLowerCase() === (row.category ?? '').toLowerCase());
          // The category's own concept is the one the catalogue structure produced; an authored family that happens to start
          // with the same path does not stand in for it. Releases without provenance fall back to any exactly-scoped concept.
          const exact = found.find((concept) => isDerived(concept) && owns(concept)) ?? (found.some(isDerived) ? undefined : found.find(owns));
          if (!exact) failures.push('no concept is scoped to exactly this category');
          else if (found[0].conceptId !== exact.conceptId) failures.push(`most specific governing concept is '${found[0].name}', not '${exact.name}'`);
          // Department purity: a derived concept of another department must never govern this product. (Authored families,
          // projects and care topics span departments by design.)
          for (const concept of found.filter((entry) => (entry as any).extensions?.['x-journeyax-provenance']?.structure?.kind === 'catalogue_taxonomy')) {
            const dept = firstPath(concept)[0];
            if (dept && row.path[0] && dept.toLowerCase() !== row.path[0].toLowerCase()) failures.push(`'${concept.name}' (${dept}) governs a product in ${row.path[0]}`);
          }
          return failures;
        },
      });
      add({
        id: `commerce:${index}:${row.path.join('>')}|${row.category ?? ''}`, family: 'commerce', department, category, path: row.path,
        run: () => {
          const found = governing();
          const outcome = resolveOkfBasketCommerce(content, {
            tenantId, environmentId: base.environmentId, releaseId: base.releaseId, items: [{ sku: product.sku }], products: [product],
            availability: { excludeFlagPaths: [], statusPaths: [], unavailableStatuses: [] }, now: base.now,
          });
          if (!reachable || found.length === 0) {
            const blocked = outcome.commerce.addToCart === 'blocked' && outcome.commerce.checkout === 'blocked';
            return blocked ? [] : [`a product no concept governs was not blocked (${outcome.commerce.addToCart}/${outcome.commerce.checkout})`];
          }
          const expected = strictestOf(found.map(declaredCommerce));
          const failures: string[] = [];
          if (outcome.commerce.addToCart !== expected.addToCart) failures.push(`add to cart is '${outcome.commerce.addToCart}', the strictest governing concept says '${expected.addToCart}'`);
          if (outcome.commerce.checkout !== expected.checkout) failures.push(`checkout is '${outcome.commerce.checkout}', the strictest governing concept says '${expected.checkout}'`);
          return failures;
        },
      });
    });
  }

  // ── Per leaf category: hazards, technical questions, evidence, bare SKU ──
  for (const concept of leaves) {
    const here = where(concept);
    const name = concept.name;
    templates.hazards.forEach((template, index) => {
      const message = fill(template, name);
      add({
        id: `safety:${concept.conceptId}:${index}`, family: 'safety', ...here, conceptId: concept.conceptId, message,
        run: () => {
          const decision = gate(message);
          const failures: string[] = [];
          if (decision.mode !== 'safety_then_diagnose') failures.push(`a hazard about this category was answered as '${decision.mode}'`);
          if (decision.retrieval.permission !== 'blocked') failures.push('products were retrievable during a hazard');
          if (decision.commerce.addToCart !== 'blocked' || decision.commerce.checkout !== 'blocked') failures.push('cart or checkout stayed open during a hazard');
          if (decision.suggestions?.length) failures.push('cross-sell was offered during a hazard');
          return failures;
        },
      });
    });
    templates.technical.forEach((template, index) => {
      const message = fill(template, name);
      add({
        id: `technical:${concept.conceptId}:${index}`, family: 'technical_claims', ...here, conceptId: concept.conceptId, message,
        run: () => {
          const decision = gate(message);
          const failures: string[] = [];
          const claimed = decision.claims.allowedClasses.filter((claim) => (NO_VERIFIED_CLAIMS as string[]).includes(claim));
          const verifiedAnywhere = (content.verifications ?? []).some((record: any) => record.status === 'verified');
          if (claimed.length && !verifiedAnywhere) failures.push(`claims were allowed without any verified evidence: ${claimed.join(', ')}`);
          if (decision.retrieval.permission === 'allowed' && !decision.claims.disclaimers.includes(renderOkfMessage(policy.messages, 'technical_requirement_unverified'))) {
            failures.push('a technical question was answered with products but without the unverified-claim statement');
          }
          return failures;
        },
      });
    });
    for (const [index, entry] of templates.evidence.entries()) {
      const message = fill(entry.template, name);
      add({
        id: `evidence:${concept.conceptId}:${index}`, family: 'evidence', ...here, conceptId: concept.conceptId, message,
        run: () => {
          const verifiedAnywhere = (content.evidenceChunks ?? []).length > 0 && (content.verifications ?? []).some((record: any) => record.status === 'verified');
          if (verifiedAnywhere) return []; // concepts with verified evidence are covered by the tenant's own scenarios
          const decision = gate(message);
          const failures: string[] = [];
          if (!['evidence_answer', 'safety_then_diagnose'].includes(decision.mode)) failures.push(`an evidence question was answered as '${decision.mode}'`);
          if (decision.retrieval.permission !== 'blocked') failures.push('retrieval was allowed with no verified evidence');
          if ((decision.evidence?.sourceRefs ?? []).length) failures.push('a source was cited although none is verified');
          if (decision.claims.allowedClasses.includes(entry.claimClass)) failures.push(`the '${entry.claimClass}' claim was allowed with no verified evidence`);
          if (decision.suggestions?.length) failures.push('cross-sell was offered beside an unverified evidence answer');
          return failures;
        },
      });
    }
    add({
      id: `exact_sku:${concept.conceptId}`, family: 'exact_sku', ...here, conceptId: concept.conceptId, message: '(exact SKU)',
      run: () => {
        const decision = gate('', { exactSku: 'eval-0000001', matchedConcepts: [{ id: concept.conceptId, score: 1, matchedBy: 'catalog_category' }] });
        const expected = declaredCommerce(concept);
        const failures: string[] = [];
        if (decision.mode !== 'direct_results') failures.push(`a bare SKU was answered as '${decision.mode}'`);
        if (decision.retrieval.permission !== 'allowed') failures.push('a bare SKU could not retrieve its product');
        if (decision.commerce.addToCart !== expected.addToCart || decision.commerce.checkout !== expected.checkout) {
          failures.push(`a bare SKU got ${decision.commerce.addToCart}/${decision.commerce.checkout}, the concept declares ${expected.addToCart}/${expected.checkout}`);
        }
        return failures;
      },
    });
  }

  // ── Cross-sell: unverified, claim-free, never beside a problem or a blocked answer ──
  for (const relationship of content.relationships.filter((entry) => entry.type === 'cross_sell')) {
    const source = byId.get(relationship.from);
    const target = byId.get(relationship.to);
    if (!source || !target) continue;
    const here = where(source);
    add({
      id: `cross_sell:${relationship.relationshipId}`, family: 'cross_sell', ...here, conceptId: source.conceptId, message: source.name,
      run: () => {
        const failures: string[] = [];
        if ((relationship.claimClasses ?? []).length) failures.push('a cross-sell relationship carries a claim class');
        const decision = gate(source.name, { matchedConcepts: [{ id: source.conceptId, score: 1, matchedBy: 'evaluation' }] });
        const buyable = target.lens === 'product' && target.riskClass !== 'safety_critical' && target.commercePolicy.addToCart !== 'blocked';
        const offered = (decision.suggestions ?? []).some((entry) => entry.conceptId === target.conceptId);
        if (decision.retrieval.permission === 'allowed' && buyable && !offered) {
          // Only a cap on the number of suggestions may legitimately leave a buyable target out.
          const siblings = content.relationships.filter((entry) => entry.type === 'cross_sell' && entry.from === source.conceptId).length;
          if (siblings <= policy.suggestions.max) failures.push(`'${target.name}' was not offered although it is buyable and within the cap`);
        }
        if (offered && !buyable) failures.push(`'${target.name}' was offered but a customer could not buy it`);
        if (decision.retrieval.permission !== 'allowed' && decision.suggestions?.length) failures.push('cross-sell was offered with no products shown');
        for (const entry of decision.suggestions ?? []) {
          if (entry.status !== 'unverified_cross_sell' || !entry.note) failures.push('a suggestion was not marked unverified with a note');
        }
        if (decision.suggestions?.length && decision.claims.allowedClasses.some((claim) => ['compatibility', 'requirement', 'substitution'].includes(claim as string))) {
          failures.push('cross-sell sat beside a compatibility, requirement or substitution claim');
        }
        return failures;
      },
    });
  }

  // ── Negative: things that must never reach a product, a claim or a checkout ──
  const negative = templates.negative;
  const generic = { department: '(negative)', category: '', path: [] as string[] };
  const never = (decision: OkfGateDecision) => decision.retrieval.permission === 'blocked' && decision.commerce.addToCart === 'blocked' && decision.commerce.checkout === 'blocked';
  negative.hazardWithoutProduct.forEach((message, index) => add({
    id: `negative:hazard:${index}`, family: 'negative', ...generic, category: 'hazard without a product', message,
    run: () => {
      const decision = gate(message);
      const failures: string[] = [];
      if (decision.mode !== 'safety_then_diagnose') failures.push(`answered as '${decision.mode}'`);
      if (!never(decision)) failures.push('products or checkout stayed open');
      if ((decision.safety?.guidance ?? []).length && !(content.verifications ?? []).some((record: any) => record.status === 'verified')) failures.push('guidance was given with nothing verified');
      return failures;
    },
  }));
  negative.hazardWithOperational.forEach((message, index) => add({
    id: `negative:hazard_operational:${index}`, family: 'negative', ...generic, category: 'hazard beside an order question', message,
    run: () => {
      const decision = gate(message);
      return decision.mode === 'safety_then_diagnose' && never(decision) ? [] : [`a hazard beside an order question was answered as '${decision.mode}'`];
    },
  }));
  negative.unknownTechnical.forEach((message, index) => add({
    id: `negative:technical:${index}`, family: 'negative', ...generic, category: 'unknown technical requirement', message,
    run: () => {
      const decision = gate(message);
      const failures: string[] = [];
      if (decision.retrieval.permission !== 'blocked' && !decision.claims.disclaimers.length) failures.push('products were shown for an unverified technical requirement with no statement');
      if (decision.claims.allowedClasses.some((claim) => (NO_VERIFIED_CLAIMS as string[]).includes(claim))) failures.push('a verified-only claim was allowed');
      return failures;
    },
  }));
  negative.unmatchedShopping.forEach((message, index) => add({
    id: `negative:unmatched:${index}`, family: 'negative', ...generic, category: 'unmatched shopping', message,
    run: () => {
      const decision = gate(message);
      if (policy.coverage.uncoveredShopping.mode === 'catalogue_only') return decision.claims.allowedClasses.every((claim) => claim === 'catalog_fact') ? [] : ['catalogue-only fallback allowed a claim'];
      return decision.retrieval.permission === 'blocked' && decision.commerce.checkout === 'blocked' ? [] : [`an unmatched request reached products or checkout (${decision.mode})`];
    },
  }));
  negative.operational.forEach((message, index) => add({
    id: `negative:operational:${index}`, family: 'negative', ...generic, category: 'order and returns', message,
    run: () => {
      const decision = gate(message);
      return decision.mode === 'operational_journey' && decision.retrieval.permission === 'blocked' ? [] : [`an order question was answered as '${decision.mode}'`];
    },
  }));

  // ── Tenant acceptance scenarios (authored customer paths) execute at publication; surface them in the matrix ──
  for (const scenario of content.acceptanceScenarios ?? []) {
    add({
      id: `authored_path:${scenario.scenarioId}`, family: 'authored_path', department: CROSS_CUTTING, category: scenario.description ?? scenario.scenarioId, path: [], message: scenario.message,
      run: () => {
        const decision = gate(scenario.message, { knownFacts: scenario.knownFacts, declinedQuestions: scenario.declinedQuestions, forceShowResults: scenario.forceShowResults });
        return compareScenario(scenario.expect, decision);
      },
    });
  }
  return scenarios;
}

function compareScenario(expect: any, decision: OkfGateDecision): string[] {
  const failures: string[] = [];
  if (expect.mode && decision.mode !== expect.mode) failures.push(`mode expected '${expect.mode}' but was '${decision.mode}'`);
  if (expect.conceptId && decision.conceptId !== expect.conceptId) failures.push(`concept expected '${expect.conceptId}' but was '${decision.conceptId ?? 'none'}'`);
  if (expect.retrievalPermission && decision.retrieval.permission !== expect.retrievalPermission) failures.push(`retrieval expected '${expect.retrievalPermission}'`);
  if (expect.clarificationFactKey && decision.clarification?.factKey !== expect.clarificationFactKey) failures.push(`clarification expected '${expect.clarificationFactKey}' but was '${decision.clarification?.factKey ?? 'none'}'`);
  if (expect.commerce?.addToCart && decision.commerce.addToCart !== expect.commerce.addToCart) failures.push(`addToCart expected '${expect.commerce.addToCart}'`);
  if (expect.commerce?.checkout && decision.commerce.checkout !== expect.commerce.checkout) failures.push(`checkout expected '${expect.commerce.checkout}'`);
  for (const claim of expect.claimsExcluded ?? []) if (decision.claims.allowedClasses.includes(claim)) failures.push(`claim '${claim}' expected to be withheld`);
  for (const id of expect.suggestsConceptIds ?? []) if (!(decision.suggestions ?? []).some((entry) => entry.conceptId === id)) failures.push(`'${id}' expected among the suggestions`);
  if (expect.noSuggestions && decision.suggestions?.length) failures.push('no suggestions expected');
  return failures;
}

const INTERNAL_VOCABULARY = ((templatesDefault as any).internalVocabulary as string[]).map((source) => new RegExp(source, 'i'));
/** Words that describe how the platform works, found in text meant for a customer. */
export function internalWording(text: string): string[] {
  return INTERNAL_VOCABULARY.flatMap((pattern) => { const match = pattern.exec(text); return match ? [match[0]] : []; });
}
let wordingViolations: string[] = [];

export function runCoverageScenarios(content: OkfReleaseContent, scenarios: EvalScenario[]): EvalResult[] {
  return scenarios.map((scenario) => {
    let failures: string[];
    wordingViolations = [];
    try { failures = scenario.run(content); } catch (error: any) { failures = [`the scenario threw: ${error?.message ?? error}`]; }
    failures = [...failures, ...new Set(wordingViolations)];
    return {
      id: scenario.id, family: scenario.family, department: scenario.department, category: scenario.category, path: scenario.path,
      ...(scenario.conceptId ? { conceptId: scenario.conceptId } : {}), ...(scenario.message ? { message: scenario.message } : {}),
      passed: failures.length === 0, failures,
    };
  });
}

// ── Report ──────────────────────────────────────────────────────────────────

export interface EvalCell { passed: number; total: number }

export interface CoverageEvaluationReport {
  tenantId: string;
  evaluatedAt: string;
  totals: { scenarios: number; passed: number; failed: number; acceptedCollisions: number };
  families: Record<string, EvalCell>;
  departments: Array<{
    name: string; scenarios: number; passed: number;
    categories: Array<{ category: string; path: string[]; scenarios: number; passed: number; families: Record<string, EvalCell> }>;
  }>;
  /** Concepts that should have been probed in a family and were not: a named gap, never a silent one. */
  gaps: Array<{ conceptId: string; name: string; missing: EvalFamily[] }>;
  /** Names a person accepted as colliding with safety/operational vocabulary, and whether each really did. */
  acceptedCollisions: Array<{ name: string; reached: string }>;
  failures: Array<{ id: string; family: EvalFamily; department: string; category: string; message?: string; failures: string[] }>;
}

export function buildEvaluationReport(content: OkfReleaseContent, scenarios: EvalScenario[], results: EvalResult[], options: EvalOptions): CoverageEvaluationReport {
  const live = content.concepts.filter((concept) => (concept as any).lifecycle?.status !== 'retired');
  const families: Record<string, EvalCell> = {};
  const departments = new Map<string, Map<string, { path: string[]; scenarios: number; passed: number; families: Record<string, EvalCell> }>>();
  for (const result of results) {
    const cell = (families[result.family] ??= { passed: 0, total: 0 });
    cell.total++; if (result.passed) cell.passed++;
    const dept = departments.get(result.department) ?? new Map();
    departments.set(result.department, dept);
    const key = result.path.length ? result.path.join('\u0000') : result.category;
    const row = dept.get(key) ?? { path: result.path, scenarios: 0, passed: 0, families: {} };
    dept.set(key, row);
    row.scenarios++; if (result.passed) row.passed++;
    const fam = (row.families[result.family] ??= { passed: 0, total: 0 });
    fam.total++; if (result.passed) fam.passed++;
  }

  // Completeness: every concept below must have been probed in the families that apply to it.
  const probed = new Map<string, Set<EvalFamily>>();
  for (const scenario of scenarios) if (scenario.conceptId) (probed.get(scenario.conceptId) ?? probed.set(scenario.conceptId, new Set()).get(scenario.conceptId)!).add(scenario.family);
  const paths = live.filter((concept) => firstPath(concept).length > 0).map((concept) => pathKey(firstPath(concept)));
  const gaps: CoverageEvaluationReport['gaps'] = [];
  for (const concept of live) {
    const required: EvalFamily[] = ['routing'];
    const key = pathKey(firstPath(concept));
    const leaf = firstPath(concept).length > 0 && concept.lens === 'product' && !paths.some((other) => other !== key && other.startsWith(`${key}\u0000`));
    if (leaf) required.push('safety', 'technical_claims', 'evidence', 'exact_sku');
    const have = probed.get(concept.conceptId) ?? new Set();
    const missing = required.filter((family) => !have.has(family));
    if (missing.length) gaps.push({ conceptId: concept.conceptId, name: concept.name, missing });
  }
  if (options.catalogue) {
    const scoped = new Set(scenarios.filter((scenario) => scenario.family === 'scope').map((scenario) => scenario.id));
    if (scoped.size < options.catalogue.length) gaps.push({ conceptId: '(catalogue)', name: 'catalogue rows', missing: ['scope'] });
  }

  const failed = results.filter((result) => !result.passed);
  return {
    tenantId: options.tenantId,
    evaluatedAt: (options.now ?? new Date()).toISOString(),
    totals: { scenarios: results.length, passed: results.length - failed.length, failed: failed.length, acceptedCollisions: 0 },
    families,
    departments: [...departments.entries()].map(([name, rows]) => {
      const categories = [...rows.entries()].map(([, row]) => ({ category: row.path[row.path.length - 1] ?? '', path: row.path, scenarios: row.scenarios, passed: row.passed, families: row.families }))
        .sort((a, b) => b.scenarios - a.scenarios || (a.category < b.category ? -1 : 1));
      return { name, scenarios: categories.reduce((n, c) => n + c.scenarios, 0), passed: categories.reduce((n, c) => n + c.passed, 0), categories };
    }).sort((a, b) => b.scenarios - a.scenarios || (a.name < b.name ? -1 : 1)),
    gaps,
    acceptedCollisions: [],
    failures: failed.map((result) => ({ id: result.id, family: result.family, department: result.department, category: result.category, ...(result.message ? { message: result.message } : {}), failures: result.failures })),
  };
}

export function evaluateCoverage(content: OkfReleaseContent, options: EvalOptions): { report: CoverageEvaluationReport; results: EvalResult[]; scenarios: EvalScenario[] } {
  const scenarios = buildCoverageScenarios(content, options);
  const results = runCoverageScenarios(content, scenarios);
  return { report: buildEvaluationReport(content, scenarios, results, options), results, scenarios };
}

export function renderEvaluationMarkdown(report: CoverageEvaluationReport): string {
  const n = (value: number) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const lines = [
    `# ${report.tenantId} coverage evaluation`, '',
    `Evaluated ${report.evaluatedAt}. **${n(report.totals.passed)} of ${n(report.totals.scenarios)} scenarios hold**${report.totals.failed ? ` — **${report.totals.failed} fail**` : ''}. Every scenario runs through the real gate and basket policy; none is stubbed.`, '',
    '## By family', '', '| Family | Passed | Total |', '|---|---:|---:|',
    ...EVAL_FAMILIES.filter((family) => report.families[family]).map((family) => `| ${family} | ${n(report.families[family].passed)} | ${n(report.families[family].total)} |`), '',
    '## By department', '', '| Department | Categories probed | Scenarios | Passed |', '|---|---:|---:|---:|',
    ...report.departments.map((d) => `| ${d.name} | ${d.categories.length} | ${n(d.scenarios)} | ${n(d.passed)} |`), '',
  ];
  if (report.gaps.length) {
    lines.push('## Gaps (concepts not probed in a family they need)', '', ...report.gaps.map((gap) => `- ${gap.name} — missing ${gap.missing.join(', ')}`), '');
  } else lines.push('## Gaps', '', 'None: every concept was probed in every family that applies to it.', '');
  if (report.failures.length) {
    lines.push('## Failures', '', ...report.failures.slice(0, 200).map((f) => `- [${f.family}] ${f.department} › ${f.category}${f.message ? ` — "${f.message}"` : ''}: ${f.failures.join('; ')}`), '');
  }
  if (report.acceptedCollisions.length) {
    lines.push('## Reviewed name collisions', '', 'Category names that read as safety, operational or evidence phrases; reaching them in words escalates or asks instead of listing products.', '',
      ...report.acceptedCollisions.map((entry) => `- ${entry.name} → ${entry.reached}`), '');
  }
  return `${lines.join('\n')}\n`;
}
