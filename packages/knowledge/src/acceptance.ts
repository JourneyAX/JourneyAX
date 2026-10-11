import type { OkfAcceptanceScenario } from './contracts';
import type { OkfGateDecision } from './gate';

/**
 * Compares a gate decision with a tenant acceptance expectation. Returns the list
 * of mismatches; an empty list means the scenario holds. Only the fields the
 * tenant stated are checked, so scenarios stay valid as unrelated behaviour evolves.
 */
export function compareAcceptanceExpectation(
  expect: OkfAcceptanceScenario['expect'],
  decision: OkfGateDecision,
): string[] {
  const failures: string[] = [];
  if (expect.mode && decision.mode !== expect.mode) {
    failures.push(`mode expected '${expect.mode}' but was '${decision.mode}'`);
  }
  if (expect.conceptId && decision.conceptId !== expect.conceptId) {
    failures.push(`concept expected '${expect.conceptId}' but was '${decision.conceptId ?? 'none'}'`);
  }
  if (expect.retrievalPermission && decision.retrieval.permission !== expect.retrievalPermission) {
    failures.push(`retrieval expected '${expect.retrievalPermission}' but was '${decision.retrieval.permission}'`);
  }
  if (expect.recommendation && decision.recommendation !== expect.recommendation) {
    failures.push(`recommendation expected '${expect.recommendation}' but was '${decision.recommendation}'`);
  }
  if (expect.clarificationFactKey && decision.clarification?.factKey !== expect.clarificationFactKey) {
    failures.push(`clarification expected fact '${expect.clarificationFactKey}' but was '${decision.clarification?.factKey ?? 'none'}'`);
  }
  if (expect.noClarification && decision.clarification) {
    failures.push(`no clarification expected but asked '${decision.clarification.factKey}'`);
  }
  for (const claim of expect.claimsIncluded || []) {
    if (!decision.claims.allowedClasses.includes(claim)) failures.push(`claim '${claim}' expected to be allowed`);
  }
  for (const claim of expect.claimsExcluded || []) {
    if (decision.claims.allowedClasses.includes(claim)) failures.push(`claim '${claim}' expected to be withheld`);
  }
  if (expect.commerce?.addToCart && decision.commerce.addToCart !== expect.commerce.addToCart) {
    failures.push(`addToCart expected '${expect.commerce.addToCart}' but was '${decision.commerce.addToCart}'`);
  }
  if (expect.commerce?.checkout && decision.commerce.checkout !== expect.commerce.checkout) {
    failures.push(`checkout expected '${expect.commerce.checkout}' but was '${decision.commerce.checkout}'`);
  }
  for (const code of expect.reasonCodesInclude || []) {
    if (!decision.trace.reasonCodes.includes(code)) failures.push(`reason code '${code}' expected`);
  }
  return failures;
}
