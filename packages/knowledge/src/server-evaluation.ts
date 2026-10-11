import { computeKnowledgeChecksum } from './checksum';
import { resolveOkfGate } from './gate';
import type { OkfDraftContent, OkfReleaseContent } from './contracts';

export interface OkfEvaluationScenarioResult {
  id: string;
  passed: boolean;
  reason?: string;
}

/**
 * Runs the publication safety matrix from the draft, never from author-supplied
 * evaluation metadata. The gate only reads graph fields; index/evaluation are
 * server-owned release metadata and are intentionally absent here.
 */
export function evaluateOkfDraft(
  draft: OkfDraftContent,
  tenantId: string,
  environmentId: string,
  releaseId: string,
  evaluatedAt: string,
): OkfEvaluationScenarioResult[] {
  const results: OkfEvaluationScenarioResult[] = [];
  const gateContent = draft as OkfReleaseContent;
  const asOf = new Date(evaluatedAt);
  if (Number.isNaN(asOf.getTime())) throw new Error('A valid server evaluation timestamp is required');
  const check = (id: string, condition: boolean, reason: string) => {
    results.push({ id, passed: condition, ...(!condition ? { reason } : {}) });
  };
  for (const concept of draft.concepts) {
    const decision = resolveOkfGate(gateContent, {
      tenantId, environmentId, releaseId, message: concept.name,
      matchedConcepts: [{ id: concept.conceptId, score: 1, matchedBy: 'publication_evaluation' }],
      now: asOf,
      knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' },
    });
    check(`${concept.conceptId}:scope`, decision.conceptId === concept.conceptId,
      'The published gate did not resolve the selected concept');
    if (concept.commercePolicy.checkout === 'blocked') {
      check(`${concept.conceptId}:checkout`, decision.commerce.checkout === 'blocked',
        'A blocked checkout policy was loosened');
    }
    if (concept.commercePolicy.addToCart === 'blocked') {
      check(`${concept.conceptId}:cart`, decision.commerce.addToCart === 'blocked',
        'A blocked cart policy was loosened');
    }
    if (concept.safety.blocksProducts || concept.riskClass === 'safety_critical') {
      check(`${concept.conceptId}:safety`, decision.retrieval.permission === 'blocked',
        'A safety-critical concept permitted product retrieval');
    }
    const revoked = resolveOkfGate(gateContent, {
      tenantId, environmentId, releaseId, message: concept.name,
      matchedConcepts: [{ id: concept.conceptId, score: 1, matchedBy: 'publication_evaluation' }],
      activeRevocations: [{
        eventId: `eval-${concept.conceptId}`, revocationId: `eval-${concept.conceptId}`,
        eventType: 'created', tenantId, environmentId: environmentId as any, releaseId,
        conceptIds: [concept.conceptId], cascade: 'none',
        effect: { suppressClaims: true, suppressRetrieval: true },
        reason: 'publication safety evaluation', createdBy: 'process:okf-evaluation',
        createdAt: new Date(asOf.getTime() - 1_000), expiresAt: new Date('9999-12-31T00:00:00.000Z'),
      }],
      now: asOf,
      knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' },
    });
    check(`${concept.conceptId}:revocation`,
      revoked.retrieval.permission === 'blocked' && revoked.commerce.checkout === 'blocked' &&
        revoked.claims.allowedClasses.length === 0,
      'An active revocation failed to suppress retrieval, checkout, or claims');
    for (const discriminator of concept.discriminators) {
      for (const [value, target] of Object.entries(discriminator.valueMap)) {
        const narrowed = resolveOkfGate(gateContent, {
          tenantId, environmentId, releaseId, message: concept.name,
          matchedConcepts: [{ id: concept.conceptId, score: 1, matchedBy: 'publication_evaluation' }],
          knownFacts: { [discriminator.factKey]: value },
          now: asOf,
          knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' },
        });
        check(`${concept.conceptId}:route:${discriminator.factKey}:${value}`,
          narrowed.conceptId === target,
          'A published discriminator did not route to its declared target');
      }
    }
  }
  const foreign = resolveOkfGate(gateContent, {
    tenantId: `foreign-${tenantId}`, environmentId, releaseId,
    message: draft.concepts[0]?.name || 'unmatched',
    matchedConcepts: draft.concepts[0]
      ? [{ id: draft.concepts[0].conceptId, score: 1, matchedBy: 'publication_evaluation' }]
      : [],
    now: asOf,
    knowledgeAvailability: { available: true, required: true, failurePolicy: 'fail_closed' },
  });
  check('cross_tenant_scope', foreign.conceptId === undefined && foreign.commerce.checkout === 'blocked',
    'Cross-tenant concept was available');
  check('nonempty_scenario_suite', draft.concepts.length > 0, 'No concepts were evaluated');
  return results;
}

/** Stable, content-bound metadata for the already-published evidence chunks. */
export function buildOkfIndexMetadata(draft: OkfDraftContent, builtAt: string) {
  const chunks = [...draft.evidenceChunks].sort((a, b) => a.chunkId < b.chunkId ? -1 : a.chunkId > b.chunkId ? 1 : 0);
  const sourceChecksum = computeKnowledgeChecksum(chunks.map(({ chunkId, sourceRef, contentHash }) => ({ chunkId, sourceRef, contentHash })));
  const entries = chunks.map(({ chunkId, conceptIds, claimClasses, title, content, applicability }) => ({
    chunkId,
    conceptIds: [...conceptIds].sort(),
    claimClasses: [...claimClasses].sort(),
    applicability,
    terms: [...new Set(`${title} ${content}`.toLowerCase().match(/[a-z0-9]{2,64}/g) || [])].sort().slice(0, 5000),
  }));
  return {
    embeddingModel: 'none',
    embeddingModelVersion: 'none',
    chunkingVersion: 'published-evidence-v1',
    indexChecksum: computeKnowledgeChecksum(entries),
    builtAt,
    sourceChecksum,
  };
}

export function buildServerOwnedOkfContent(
  draft: OkfDraftContent,
  scope: { tenantId: string; environmentId: string; releaseId: string; evaluatedAt: string },
): OkfReleaseContent {
  const scenarios = evaluateOkfDraft(draft, scope.tenantId, scope.environmentId, scope.releaseId, scope.evaluatedAt);
  const failures = scenarios.filter((scenario) => !scenario.passed);
  if (failures.length) {
    throw new Error(`OKF publication evaluation failed: ${failures.map(({ id, reason }) => `${id}: ${reason}`).join('; ')}`);
  }
  return {
    ...draft,
    index: buildOkfIndexMetadata(draft, scope.evaluatedAt),
    evaluation: {
      reportId: `eval-${computeKnowledgeChecksum(scenarios)}`,
      passed: true,
      evaluatedAt: scope.evaluatedAt,
      scenarioCount: scenarios.length,
      failedScenarioCount: 0,
    },
  };
}
