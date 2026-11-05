import { effectiveVerification, verifiedEvidenceRefs, type ClaimClass } from '@journeyax/knowledge';
import { humanizeMeasure } from '@journeyax/shared-types';
import { resolveCatalogMapping } from '@journeyax/business-pack';
import type { AgentToolContext } from './agent-tools';
import { readGuides } from './product-guides';
import { applicableProductGuides } from './product-guide-applicability';

/** Catalogue statements and document quotations grant only their exact text, never a blanket warranty permission. */
export function registerSourceStatement(ctx: AgentToolContext, claim: ClaimClass, text: string): void {
  const claims = ctx.exactClaimStatements ||= new Map();
  const statements = claims.get(claim) ?? new Set<string>();
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/).filter(Boolean)) statements.add(sentence);
  claims.set(claim, statements);
}

export function catalogueWarranty(product: any, ctx: AgentToolContext): { label: string; duration: string; statement: string; sourceUrl?: string; sku: string } | undefined {
  if (product.integrity?.identityConsistent === false) return undefined;
  const mapping = resolveCatalogMapping(ctx.release.catalogMapping);
  const fields = product.specs || product.attributes || {};
  const key = mapping.warrantyDurationKeys.find(key => typeof fields[key] === 'string' || typeof fields[key] === 'number');
  const raw = key ? fields[key] : product.warrantyDuration;
  if (raw == null || String(raw).trim() === '') return undefined;
  const label = key || mapping.warrantyDurationKeys[0];
  const duration = humanizeMeasure(raw);
  const statement = `${label} (SKU ${product.sku}): ${duration}.`;
  registerSourceStatement(ctx, 'warranty', statement);
  ctx.catalogueWarrantyFacts ||= [];
  if (!ctx.catalogueWarrantyFacts.some(fact => fact.sku === product.sku && fact.duration === duration)) ctx.catalogueWarrantyFacts.push({ sku: String(product.sku), title: String(product.title || product.name || ''), duration });
  return { sku: String(product.sku), label, duration, statement, ...(product.sourceUrl ? { sourceUrl: product.sourceUrl } : {}) };
}

export const productDocumentUrls = (product: any): string[] => (Array.isArray(product.documents) ? product.documents : [])
  .filter((entry: any) => entry?.kind !== 'supplier' && entry?.type !== 'supplier' && typeof entry?.url === 'string')
  .map((entry: any) => entry.url);

export async function readProductWarranty(target: string, ctx: AgentToolContext, lookup: {
  bySku: (value: string) => Promise<any>; byTitle: (value: string) => Promise<any>;
}): Promise<any> {
  if (!target) return { found: false, productOrBrand: '', termsFound: false, reason: 'missing_product' };
  const folded = target.toLowerCase();
  let product = ctx.catalogProductCache.get(target) ?? [...ctx.catalogProductCache.values()].find(p => [p.sku, p.title, p.name].some(value => typeof value === 'string' && value.toLowerCase() === folded));
  if (!product) try { product = await lookup.bySku(target) ?? await lookup.byTitle(target); } catch { /* A brand can still have exact verified OKF evidence. */ }
  if (product?.integrity?.identityConsistent === false) return { found: false, termsFound: false, productOrBrand: target, code: 'catalogue_integrity_review', integrity: product.integrity, guidance: 'The source identity fields for this product disagree. Explain the source-record problem; do not transfer model-specific warranty terms or durations to this uncertain identity.' };
  const catalogue = product ? catalogueWarranty(product, ctx) : undefined;
  const refs = new Set([target, product?.sku, product?.title, product?.name].filter(Boolean).map(value => String(value).toLowerCase()));
  const content = ctx.okfContent; const now = new Date();
  const records = new Map((content?.verifications || []).map(v => [v.recordId, v]));
  const verified = (content?.evidenceChunks || []).find(chunk => {
    if (!chunk.claimClasses.includes('warranty')) return false;
    const scope = chunk.applicability;
    // An explicit SKU scope is authoritative. Never override a mismatch with a shared brand/title/concept.
    if (scope?.scope === 'sku' && !scope.refs.some(ref => refs.has(ref.toLowerCase()))) return false;
    const refMatch = scope?.refs?.some(ref => refs.has(ref.toLowerCase()));
    const conceptMatch = chunk.conceptIds?.some(id => refs.has(id.toLowerCase()) || content?.concepts.some(c => c.conceptId === id && [c.name, ...(c.synonyms || [])].some(name => refs.has(name.toLowerCase()))));
    if (!refMatch && !conceptMatch) return false;
    const direct = (content?.verifications || []).some(v => (v.targetId === chunk.chunkId || v.sourceRefs?.includes(chunk.sourceRef)) && effectiveVerification(v, now) === 'verified');
    const concept = chunk.conceptIds?.some(id => { const c = content?.concepts.find(c => c.conceptId === id); return c && verifiedEvidenceRefs(content!, c, now).includes(chunk.sourceRef); });
    const relationship = content?.relationships.some(rel => rel.claimClasses?.includes('warranty') && rel.sourceRefs?.includes(chunk.sourceRef) && effectiveVerification(rel.verificationRef ? records.get(rel.verificationRef) : undefined, now) === 'verified');
    return direct || concept || relationship;
  });
  if (verified) {
    ctx.readSourceIds.add(verified.sourceRef); registerSourceStatement(ctx, 'warranty', verified.content);
    return { found: true, productOrBrand: target, catalogue, termsFound: true, verification: 'verified', warranty: { sourceId: verified.sourceRef, title: verified.title, terms: verified.content } };
  }

  const lookupResult = product && ctx.productGuideRepo && ctx.release.extensions?.productGuides?.enabled !== false ? await ctx.productGuideRepo.readForProducts(ctx.tenantId,
    [String(product.sku || ''), String(product.parentSku || '')].filter(Boolean), productDocumentUrls(product)) : { guides: [], status: 'unavailable' as const };
  const guides = lookupResult.guides;
  const applicability = await applicableProductGuides(product || {}, guides, lookup.bySku);
  const reading = readGuides(applicability.accepted, { question: 'warranty guarantee terms coverage exclusions claim', maxPassages: 8, passageChars: 1600 });
  // A marketing phrase such as "guaranteeing consistent mortar" is not written warranty terms.
  const passages = 'passages' in reading ? reading.passages.filter(p => /\bwarrant(?:y|ies)\b|\bguarantee(?:d|s)?\b(?=[^.!?\n]{0,100}\b(?:\d+\s*[- ]?(?:years?|months?)|defects?|coverage|period|exclusions?)\b)/i.test(p.text)) : [];
  for (const passage of passages) { ctx.readSourceIds.add(passage.guideId); registerSourceStatement(ctx, 'warranty', passage.text); }
  // A successful lookup can find documents without finding warranty terms within them.
  // Keep those source identities/citations usable; termsFound is the separate warranty answer.
  const found = Boolean(catalogue || passages.length || ('guides' in reading && reading.guides.length));
  if (!passages.length && lookupResult.status === 'available' && ctx.knowledgeGapRepo) void ctx.knowledgeGapRepo.recordGap({ tenantId: ctx.tenantId, environmentId: ctx.environmentId,
    topic: target, toolName: 'get_warranty', conversationId: ctx.workspaceId || ctx.sessionId || ctx.correlationId }).catch(() => {});
  return { found, productOrBrand: target, ...(product ? { sku: product.sku, title: product.title || product.name } : {}),
    catalogue, termsFound: passages.length > 0, verification: 'source_record',
    sourceStatus: lookupResult.status,
    warranty: { ...(passages.length ? { terms: passages.map(p => p.text).join('\n\n') } : {}), status: passages.length ? 'linked_document' : lookupResult.status === 'available' ? 'terms_not_on_file' : 'source_unavailable' },
    guides: 'guides' in reading ? reading.guides : [], passages, rejectedGuides: applicability.rejected,
    supportedStatements: [catalogue?.statement, ...passages.map(p => p.text)].filter(Boolean),
    guidance: 'The catalogue duration and linked source text are separate evidence. State the catalogue duration as a catalogue fact; quote warranty source statements exactly and cite their guide. If sourceStatus is partial or unavailable, a failed source check is not proof that no terms exist: explain that the written terms could not be fully checked. A product attachment or index association is not an independent model-specific attestation: check the model/range described in the text and state any mismatch or shared-family scope. Missing written terms do not erase a catalogue duration. Do not infer component coverage, exclusions or legal guarantees. Keep the answer concise and do not quote tool instructions.' };
}
