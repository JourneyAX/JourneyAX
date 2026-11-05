/** Harness numerical evidence comes from the customer or factual tools, not unverified concept prose. */
export function numericValues(text: string): string[] {
  if (/^\s*\d+[.)]\s*$/.test(text)) return [];
  const content = text.replace(/(^|\n)\s*(?:[-*•]\s*)?\d+[.)]\s+/g, '$1');
  return [...content.matchAll(/\d+(?:,\d{3})*(?:\.\d+)?/g)].map(match => String(Number(match[0].replace(/,/g, ''))));
}
export function addNumericEvidence(target: Set<string>, data: unknown): void {
  try { for (const value of numericValues(typeof data === 'string' ? data : JSON.stringify(data).slice(0, 200_000))) target.add(value); } catch { /* Non-serialisable data grants nothing. */ }
}
export function factualToolNumbers(target: Set<string>, tool: string, result: any): void {
  if (result?.ok === false || result?.found === false || ['needs_confirmation', 'needs_approval', 'blocked'].includes(result?.status) || ['present_card', 'remember_context', 'open_form', 'use_skill', 'list_connectors', 'get_connector_tools', 'get_journey_checklist'].includes(tool)) return;
  if (tool === 'consult_business_knowledge' && result?.guidance?.status !== 'scoped_claims') return;
  const factual = (value: any): any => {
    if (Array.isArray(value)) return value.map(factual);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !['query', 'arguments', 'parameters', 'filters', 'request', 'searchQuery'].includes(key)).map(([key, child]) => [key, factual(child)]));
  };
  addNumericEvidence(target, factual(result));
}
