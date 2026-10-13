import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { internalWording } from '@journeyax/knowledge';
import type { Decision, WorkspaceState } from '@journeyax/journey-core';
import { PresentationPort } from '../src/kernel/presentation.port';
import { resolveInterpretationPolicy } from '../src/turn/fact-semantics';
import { buildCanonicalPackContent } from './fixtures/canonical-release.fixture';

/**
 * What a customer reads when something does not go to plan. Every sentence the runtime writes itself comes from data
 * (the pack's runtime messages or the tenant's knowledge policy); internal reasons stay in the decision and the logs.
 */
const suite = createSuite('runtime: customer wording when a turn cannot proceed');

const baseRelease = () => buildCanonicalPackContent({
  tenantId: 'tenant-wording', environmentId: 'test', version: '1.0.0',
  capabilities: { toolDefinitions: [], toolBindings: [], stageBindings: [] },
});
const workspace: WorkspaceState = {
  tenantId: 'tenant-wording', environmentId: 'test', workspaceId: 'ws-wording', packVersionId: '1.0.0', journeyId: 'j', currentStage: 's',
  facts: {}, decisions: [], selectedObjects: [], openQuestions: [], status: 'active', stateVersion: 1,
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
} as WorkspaceState;
const failure = (reason: string, payload: Record<string, unknown> = {}): Decision => ({
  decisionId: 'd', type: 'fail', payload: { error: reason, ...payload }, reason, createdAt: new Date().toISOString(),
} as Decision);
const port = new PresentationPort();
const compose = (decision: Decision, release: any = baseRelease(), options: any = {}, validated: any = { valid: false, notes: decision.reason }) =>
  port.compose(validated, decision, workspace, release, options);

async function main() {
  await suite.test('engine diagnostics never reach the customer; they get the tenant-configurable generic sentence', () => {
    for (const note of [
      'No capability execution outcome provided for validation.',
      "Capability outcome for 'catalog.search' is missing required field 'items' declared in output schema.",
      "Relationship 'rel-care-deck' is unverified; compatibility claims are not permitted.",
      'upstream timeout after 8000ms',
    ]) {
      const message = compose(failure(note)).assistantMessage!;
      assert.equal(message, resolveInterpretationPolicy().messages.action_not_completed);
      assert.deepEqual(internalWording(message), [], message);
      assert.ok(!message.includes(note.slice(0, 20)), 'the diagnostic is not echoed');
    }
  });

  await suite.test('the diagnostic is kept for people who debug: it stays on the decision', () => {
    const result = compose(failure('upstream timeout after 8000ms'));
    assert.equal(result.decision.reason, 'upstream timeout after 8000ms');
  });

  await suite.test('wording written for the customer (a policy message or a rule remediation) is shown exactly as written', () => {
    const message = 'This is wording a person at the business wrote.';
    assert.equal(compose(failure(message, { customerMessage: true })).assistantMessage, message);
  });

  await suite.test('a missing stage input asks the customer for details instead of exposing the stage', () => {
    const message = compose(failure("Stage 'airway' requires input: delivery_zone")).assistantMessage!;
    assert.equal(message, resolveInterpretationPolicy().messages.clarify_project_details);
    assert.ok(!message.includes('airway') && !message.includes('delivery_zone'));
  });

  await suite.test('a request outside every journey is answered from the pack: its name and the journeys it offers', () => {
    const release: any = baseRelease();
    release.profile = { ...(release.profile ?? {}), companyName: 'Wording Co' };
    release.journeys = [{ journeyId: 'a', displayName: 'Bathroom renovation' }, { journeyId: 'b', displayName: 'Deck building' }];
    const message = compose(failure('No matching journey found for the request'), release, { customerQuery: 'tell me a joke' }).assistantMessage!;
    assert.ok(message.includes('Wording Co') && message.includes('Bathroom renovation, Deck building'), message);
    assert.deepEqual(internalWording(message), [], message);
  });

  await suite.test('without a company name the sentence is complete, not "I\'m your our consultant"', () => {
    const release: any = baseRelease();
    release.profile = { ...(release.profile ?? {}), companyName: '' };
    release.manifest = { ...release.manifest, name: '' };
    release.journeys = [];
    const message = compose(failure('No matching journey found'), release, { customerQuery: 'hello?' }).assistantMessage!;
    assert.ok(!/\bour\b.*\bour\b|your our|undefined|\{/.test(message), message);
    assert.equal(message, resolveInterpretationPolicy().messages.out_of_scope.replace('{offering}', resolveInterpretationPolicy().messages.out_of_scope_offering_default));
  });

  await suite.test('a pack overrides the runtime wording, and the override wins over the platform default', () => {
    const release: any = baseRelease();
    release.extensions = { interpretationPolicy: { messages: { action_not_completed: 'Kei te pai, try again in a moment.' } } };
    assert.equal(compose(failure('boom'), release).assistantMessage, 'Kei te pai, try again in a moment.');
  });

  await suite.test('the tenant knowledge policy wins over the pack runtime wording', () => {
    const release: any = baseRelease();
    release.extensions = { interpretationPolicy: { messages: { action_not_completed: 'pack wording' } } };
    assert.equal(compose(failure('boom'), release, { messages: { action_not_completed: 'tenant policy wording' } }).assistantMessage, 'tenant policy wording');
  });

  await suite.test('approval prompts and button labels are data, not code', () => {
    const release: any = baseRelease();
    release.experience.cards.allowedCardTypes = ['action_button_group'];
    release.extensions = { interpretationPolicy: { messages: { approval_confirm: 'Yes, go ahead', approval_cancel: 'Not now', approval_heading: 'One moment' } } };
    const approval = { decisionId: 'd', type: 'requires_approval', payload: { displayName: 'Place order', toolId: 'order.place' }, reason: 'approval', createdAt: new Date().toISOString() } as Decision;
    const result = compose(approval, release, {}, { valid: true });
    const card: any = result.uiInstructions.find((instruction: any) => instruction.component === 'action_button_group');
    assert.ok(card, 'the approval card is presented');
    assert.equal(card.props.heading, 'One moment');
    assert.deepEqual(card.props.actions.map((action: any) => action.label), ['Yes, go ahead', 'Not now']);
    assert.ok(result.assistantMessage!.includes('Place order'));
    assert.ok(!/\*\*|⚠️/.test(result.assistantMessage!), 'no markup or decoration is written by code');
  });

  await suite.test('a decision with no message of its own never shows its engine reason; the pack\'s welcome wording is used instead', () => {
    const release: any = baseRelease();
    release.experience = { ...(release.experience ?? {}), welcomeMessage: undefined };
    release.vocabulary = { ...(release.vocabulary ?? {}), welcomeMessage: undefined };
    for (const reason of ['Greeting received; presenting welcome decision', "All requirements for stage 'catalogue' satisfied.", 'Tool definition \'x\' not declared in Business Pack']) {
      const decision = { decisionId: 'd', type: 'complete_goal', payload: {}, reason, createdAt: new Date().toISOString() } as Decision;
      const message = compose(decision, release, {}, { valid: true }).assistantMessage!;
      assert.equal(message, resolveInterpretationPolicy().messages.welcome_default);
    }
    const written = { decisionId: 'd', type: 'complete_goal', payload: { customerMessage: true }, reason: 'Written for the customer.', createdAt: new Date().toISOString() } as Decision;
    assert.equal(compose(written, release, {}, { valid: true }).assistantMessage, 'Written for the customer.');
  });

  await suite.test('prices that cannot be shown safely produce one plain sentence, not an engineering explanation', () => {
    const release: any = baseRelease();
    delete release.profile.primaryCurrency;
    const decision = { decisionId: 'd', type: 'invoke_capability', targetCapability: 'catalog.search', payload: {}, reason: 'ok', createdAt: new Date().toISOString() } as Decision;
    const result = compose(decision, release, { capability: { toolId: 'catalog.search' } }, { valid: true, outcome: { items: [{ sku: 'A', title: 'Item A', priceCents: 1000 }] } });
    assert.equal(result.assistantMessage, resolveInterpretationPolicy().messages.prices_unavailable);
    assert.deepEqual(internalWording(result.assistantMessage!), [], result.assistantMessage);
    assert.equal(result.uiInstructions.length, 0, 'no product card is shown without a currency to price it in');
  });

  await suite.test('every runtime message the platform ships is plain language', () => {
    const messages = resolveInterpretationPolicy().messages;
    assert.ok(Object.keys(messages).length > 20);
    for (const [key, template] of Object.entries(messages)) {
      assert.deepEqual(internalWording(template.replace(/\{[A-Za-z0-9_]+\}/g, 'item')), [], `message '${key}' exposes internal wording: ${template}`);
    }
  });

  await suite.test('the presentation port holds no customer sentence of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('../src/kernel/presentation.port.ts', import.meta.url), 'utf8');
    for (const phrase of ['I was unable to complete', 'Approval Required', 'Kia ora', 'Matching Products', 'Unable to present', 'Verified options']) {
      assert.ok(!source.includes(phrase), `'${phrase}' must come from data`);
    }
    const turnSource = readFileSync(new URL('../src/kernel/turn-application.service.ts', import.meta.url), 'utf8');
    for (const phrase of ['I cannot verify that detail', 'published merchant guidance', "I don't have verified technical specifications"]) {
      assert.ok(!turnSource.includes(phrase), `'${phrase}' must come from data`);
    }
  });

  process.exitCode = suite.finish() ? 0 : 1;
}

main().catch((error) => { console.error(error); process.exit(1); });
