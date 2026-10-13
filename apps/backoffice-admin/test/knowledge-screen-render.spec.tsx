import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  analyzeKnowledgeCoverage, applyAuthoring, buildServerOwnedOkfContent, buildTaxonomyDraft, findStaleVerifications, findVerificationWork,
} from '../../../packages/knowledge/src';
import { KnowledgeSummary } from '../src/components/okf/KnowledgeSummary';
import { RelationshipList } from '../src/components/okf/RelationshipList';
import { VerificationQueue } from '../src/components/okf/VerificationQueue';

/**
 * The Knowledge screen on the real PlaceMakers release (committed snapshot + authoring proposal), not on a toy: what a business sees,
 * and that it stays short however big the catalogue is. Before, the checklist listed all 963 topics and links as "not verified".
 */
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ✓ ${passed}. ${name}`);
}

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const snapshot = read('docs/inventory/placemakers-taxonomy-snapshot-2026-10-13.json');
const authored = applyAuthoring(buildTaxonomyDraft(snapshot, read('scripts/okf/tenants/placemakers.ingest.json')), read('scripts/okf/tenants/placemakers.authoring.json'));
const content: any = buildServerOwnedOkfContent(authored.draft, { tenantId: 'placemakers', environmentId: 'production', releaseId: 'screen', evaluatedAt: snapshot.snapshotAt });
const everything = findStaleVerifications(content);
const work = findVerificationWork(content);
const analysis: any = {
  tenantId: 'placemakers', environmentId: 'production', revision: 1, artifactRequired: false, verifierRoles: [{ roleId: 'trade_expert', label: 'Trade expert' }, { roleId: 'safety_officer', label: 'Safety officer' }],
  staleness: work, checks: [{ id: 'verifications_current', ok: false, advisory: true, detail: `${work.length} item(s) need verification` }], ready: true,
};
const noop = () => undefined;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

console.log('🧪 backoffice: the Knowledge screen on the real PlaceMakers release');

check('the checklist holds what a person can confirm, not all 963 topics and links', () => {
  assert.equal(everything.length, content.concepts.length + content.relationships.length);
  const html = renderToStaticMarkup(<VerificationQueue analysis={analysis} content={content} roles={analysis.verifierRoles} busy={false} onAssign={noop} onAssignMany={noop} onAttest={noop} onConfigureRole={noop} />);
  const words = text(html);
  const topic = (name: string) => work.filter((entry) => entry.about === name).length;
  assert.match(words, new RegExp(`Problems and safety \\(${topic('safety')}\\)`));
  assert.match(words, new RegExp(`Care advice \\(${topic('care')}\\)`));
  assert.match(words, new RegExp(`What goes with what \\(${topic('compatibility')}\\)`));
  assert.match(words, new RegExp(`Manufacturer documents to review \\(${topic('documents')}\\)`));
  assert.match(words, new RegExp(`${work.length} topics waiting`));
  assert.doesNotMatch(words, new RegExp(`\\b${everything.length}\\b`), 'the whole tree is never presented as work');
  assert.doesNotMatch(words, /Not verified \(/);
  assert.ok(work.length < everything.length / 3);
  // The category tree and suggestions never appear as things to confirm (a row would read "Screws sits inside Fastenings").
  assert.doesNotMatch(words, /[A-Za-z&] (sits inside|goes well with) [A-Z]/);
  assert.match(words, /Bathroom leak/, 'a real problem is listed by name');
});

check('what matters first comes first, and the long tail says it can wait', () => {
  const words = text(renderToStaticMarkup(<VerificationQueue analysis={analysis} content={content} roles={analysis.verifierRoles} busy={false} onAssign={noop} onAttest={noop} onConfigureRole={noop} />));
  const order = ['Problems and safety', 'Care advice', 'What goes with what', 'Manufacturer documents to review'].map((title) => words.indexOf(title));
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'safety first');
  assert.ok(order.every((at) => at >= 0));
  assert.match(words, /can wait/);
  assert.match(words, /this is a safety lock/, 'it says why, in plain words');
  assert.match(words, /Nothing is broken/);
  // Each part of the shop can be handed to one person, with a count.
  assert.match(words, /Bathrooms & Plumbing · \d+ topics?/);
  assert.match(words, /Assign all \d+/);
  assert.match(words, /Problems · 6 topics/);
});

check('every list is bounded, so the page does not grow with the catalogue', () => {
  const html = renderToStaticMarkup(<VerificationQueue analysis={analysis} content={content} roles={analysis.verifierRoles} busy={false} onAssign={noop} onAssignMany={noop} onAttest={noop} onConfigureRole={noop} />);
  const lists = html.match(/<div style="max-height:200px;overflow:auto/g) ?? [];
  assert.ok(lists.length > 0);
  // Every row of the checklist lives inside one of those scrolling boxes; the only things outside are the headings and the group buttons.
  const rows = (html.match(/>Assign</g) ?? []).length;
  assert.equal(rows, work.length, 'one row per topic, each inside a scrolling box');
  const relationships = renderToStaticMarkup(<RelationshipList content={content} />);
  assert.ok((relationships.match(/max-height:260px/g) ?? []).length >= 1);
  assert.match(text(relationships), new RegExp(`${content.relationships.length} links in all\\. 8 state something`));
  assert.match(text(relationships), new RegExp(`Show the ${content.relationships.length - 8} links that make no claim`));
});

check('the summary says in words whether customers are served and how much waits for a person', () => {
  // The service wraps this in its own envelope (environment, revision, pack); the screen reads only the figures.
  const coverage: any = analyzeKnowledgeCoverage(content);
  const live: any = { active: { packVersion: '1.3.17', knowledge: { releaseId: 'r', version: '1.7.0', checksum: 'c', required: true } } };
  const words = text(renderToStaticMarkup(<KnowledgeSummary lifecycle={live} coverage={coverage} analysis={analysis} verifiedByPeople={0} />));
  assert.match(words, /Customers are being served with knowledge release 1\.7\.0/);
  assert.match(words, /holds back any advice nobody has confirmed yet/);
  assert.match(words, new RegExp(`Topics it knows ${content.concepts.length.toLocaleString()}`));
  assert.match(words, new RegExp(`Waiting for a person ${work.length.toLocaleString()}`));
  assert.match(words, /Confirmed by a person 0/);
  assert.match(text(renderToStaticMarkup(<KnowledgeSummary lifecycle={{ ...live, active: null }} coverage={coverage} analysis={analysis} verifiedByPeople={0} />)), /No knowledge release is live yet/);
  assert.match(text(renderToStaticMarkup(<KnowledgeSummary lifecycle={null} coverage={null} analysis={null} verifiedByPeople={0} />)), /Loading what the assistant knows/);
});

console.log(`✅ backoffice Knowledge screen on real data: ${passed} passed, 0 failed`);
