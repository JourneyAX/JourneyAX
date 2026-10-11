import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReadinessPanel } from '../src/components/okf/ReadinessPanel';
import { RelationshipList } from '../src/components/okf/RelationshipList';
import { VerificationQueue } from '../src/components/okf/VerificationQueue';
import { RevocationPanel } from '../src/components/okf/RevocationPanel';
import { ImportExportBar } from '../src/components/okf/ImportExportBar';
import { ArtifactPolicyToggle } from '../src/components/okf/ArtifactPolicyToggle';
import { ConceptEditor } from '../src/components/okf/ConceptEditor';
import { PackSettingsEditor } from '../src/components/okf/PackSettingsEditor';

let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const hash = (c: string) => c.repeat(64);
const content: any = {
  factRegistry: [{ factKey: 'outlet_type' }],
  concepts: [{
    conceptId: 'concept://t/a', name: 'Toilet suites', description: 'd', synonyms: ['wc'], customerPhrases: [], riskClass: 'compatibility',
    compatibilitySensitive: true, commercePolicy: { addToCart: 'allowed', checkout: 'requires_compatibility_resolution' },
    safety: { blocksProducts: false, stepRefs: [] }, lifecycle: { status: 'active_draft' }, requiredFacts: [{ factKey: 'outlet_type', importance: 'high' }],
    searchScope: { catalogCategoryIds: ['toilets'], enrichmentFacets: [], excludeCategoryIds: [] }, lens: 'product', contentHash: hash('a'),
  }],
  relationships: [{ relationshipId: 'r1', from: 'concept://t/a', to: 'concept://t/a', type: 'compatible_with', strength: 'required', scope: 'family', confidence: 'high', contentHash: hash('b') }],
  verifications: [{ recordId: 'v1', targetType: 'relationship', targetId: 'r1', status: 'verified', verifiedBy: 'human:bob', verifierRole: 'trade_expert', contentHash: hash('b') }],
};
const analysis: any = {
  tenantId: 't', environmentId: 'production', revision: 2, artifactRequired: true, verifierRoles: [{ roleId: 'trade_expert', label: 'Trade expert' }],
  staleness: [{ targetType: 'concept', targetId: 'concept://t/a', reason: 'unverified' }],
  checks: [{ id: 'draft_valid', ok: true }, { id: 'verifications_current', ok: false, detail: '1 item(s) need verification' }, { id: 'unknown_future_check', ok: false }],
  ready: false,
};
const noop = () => undefined;

console.log('🧪 backoffice: OKF Studio components render');

check('readiness lists server checks with friendly labels and falls back to the id', () => {
  const html = renderToStaticMarkup(<ReadinessPanel analysis={analysis} />);
  assert.match(html, /Not ready/);
  assert.match(html, /passes validation/);
  assert.match(html, /1 item\(s\) need verification/);
  assert.match(html, /unknown_future_check/);
  assert.match(renderToStaticMarkup(<ReadinessPanel analysis={null} />), /once a draft exists/);
});

check('relationships show names, type and a verification badge', () => {
  const html = renderToStaticMarkup(<RelationshipList content={content} />);
  assert.match(html, /Toilet suites/);
  assert.match(html, /compatible with/);
  assert.match(html, /Verified/);
});

check('verification queue groups stale items and offers attestation for verified records', () => {
  const html = renderToStaticMarkup(
    <VerificationQueue analysis={analysis} content={content} roles={analysis.verifierRoles} busy={false} onAssign={noop} onAttest={noop} onConfigureRole={noop} />,
  );
  assert.match(html, /Not verified \(1\)/);
  assert.match(html, /Trade expert/);
  assert.match(html, /Attest/);
  assert.match(html, /not the draft author/);
});

check('revocation panel separates active revocations and requires a corrected release to lift', () => {
  const revocations: any = [{
    revocationId: 'rv1', status: 'active',
    created: { reason: 'Recall', createdBy: 'human:alice', expiresAt: '2099-01-01T00:00:00.000Z', conceptIds: ['concept://t/a'], releaseId: 'rel-1' },
  }];
  const releases: any = [{ releaseId: 'rel-1', version: '1.0.0', status: 'ready' }, { releaseId: 'rel-2', version: '1.0.1', status: 'ready' }];
  const html = renderToStaticMarkup(<RevocationPanel revocations={revocations} releases={releases} concepts={[{ conceptId: 'concept://t/a', name: 'Toilet suites' }]} busy={false} onCreate={noop} onLift={noop} />);
  assert.match(html, /1 concept\(s\) withdrawn/);
  assert.match(html, /Recall/);
  assert.match(html, /Corrected release/);
  assert.match(html, /1\.0\.1/);
});

check('import/export bar disables export without a ready release', () => {
  const none = renderToStaticMarkup(<ImportExportBar releases={[]} busy={false} onImport={noop} onExport={noop} />);
  assert.match(none, /Export latest release/);
  assert.match(none, /disabled=""[^>]*>(?:(?!<button)[\s\S])*?Export latest/);
});

check('artifact policy reflects state', () => {
  assert.match(renderToStaticMarkup(<ArtifactPolicyToggle required onChange={noop} />), /checked=""/);
  assert.doesNotMatch(renderToStaticMarkup(<ArtifactPolicyToggle required={false} onChange={noop} />), /checked=""/);
});

check('concept editor renders the selected concept, its facts and policy controls', () => {
  const html = renderToStaticMarkup(<ConceptEditor content={content} busy={false} onSave={noop} />);
  assert.match(html, /Toilet suites/);
  assert.match(html, /Save concept/);
  assert.match(html, /requires_compatibility_resolution/);
  assert.match(renderToStaticMarkup(<ConceptEditor content={{ concepts: [] }} busy={false} onSave={noop} />), /No concepts yet/);
});

check('pack settings show current values and blank for platform defaults', () => {
  const project: any = { projectId: 'p', catalogMapping: { candidateLimit: 50 }, extensions: { workspacePinPolicy: { idleRepinAfterHours: 12 } } };
  const html = renderToStaticMarkup(<PackSettingsEditor project={project} />);
  assert.match(html, /Catalogue mapping/);
  assert.match(html, /candidateLimit/);
  assert.match(html, /idleRepinAfterHours/);
  assert.match(html, /Empty = platform defaults/);
  assert.match(html, /validated by the service/);
});

console.log(`✅ backoffice OKF Studio components: ${passed} passed, 0 failed`);
