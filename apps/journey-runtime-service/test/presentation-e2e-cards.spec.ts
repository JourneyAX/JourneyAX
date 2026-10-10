import assert from 'node:assert/strict';
import type { Decision, WorkspaceState } from '@journeyax/journey-core';
import { PresentationPort } from '../src/kernel/presentation.port';
import { buildCanonicalPackContent } from './fixtures/canonical-release.fixture';

const release = buildCanonicalPackContent({
  tenantId: 'tenant-card-test',
  environmentId: 'test',
  version: '1.0.0',
  capabilities: { toolDefinitions: [], toolBindings: [], stageBindings: [] },
});
release.experience.cards.allowedCardTypes = [
  'guide',
  'warranty',
  'quote',
  'cart',
  'bundle',
  'order_confirmation',
];

const workspace: WorkspaceState = {
  tenantId: 'tenant-card-test',
  environmentId: 'test',
  workspaceId: 'ws-card-test',
  packVersionId: '1.0.0',
  journeyId: 'journey_outbox_fixture',
  currentStage: 'stage_sync',
  facts: {},
  decisions: [],
  selectedObjects: [],
  openQuestions: [],
  status: 'active',
  stateVersion: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function decision(targetCapability: string, payload: Record<string, unknown> = {}): Decision {
  return {
    decisionId: `decision-${targetCapability}`,
    type: 'invoke_capability',
    targetCapability,
    payload,
    reason: 'Verified capability result',
    createdAt: new Date().toISOString(),
  };
}

function card(result: any, type: string) {
  return result.uiInstructions.find((instruction: any) => instruction.component === type);
}

async function main() {
  console.log('🧩 Running end-to-end presentation contract suite...');
  const port = new PresentationPort();

  const knowledgeScope = {
    releaseId: 'okf-card-test-1',
    version: '1.0.0',
    checksum: 'a'.repeat(64),
    conceptIds: ['concept://tenant-card-test/care/item'],
    sourceRefs: ['source-approved'],
    requestedClaimClass: 'care_safety',
  };
  const guideResult = port.compose({
    valid: true,
    outcome: {
      verified: true,
      results: [{
        sourceId: 'source-approved',
        releaseId: knowledgeScope.releaseId,
        title: 'Verified care guide',
        content: 'Follow the manufacturer care instructions.',
      }],
    },
  }, decision('knowledge.search', { knowledgeScope }), workspace, release);
  assert.equal(card(guideResult, 'guide')?.props.sections[0].body, 'Follow the manufacturer care instructions.');

  const warrantyResult = port.compose({
    valid: true,
    outcome: {
      verified: true,
      results: [{
        sourceId: 'source-approved',
        releaseId: knowledgeScope.releaseId,
        title: 'Verified warranty document',
        content: 'Warranty terms supplied by the verified source.',
        url: 'https://merchant.invalid/warranty',
      }],
    },
  }, decision('knowledge.search', {
    knowledgeScope: { ...knowledgeScope, requestedClaimClass: 'warranty' },
  }), workspace, release);
  assert.equal(card(warrantyResult, 'warranty')?.props.items[0].title, 'Verified warranty document');

  const quoteResult = port.compose({
    valid: true,
    outcome: {
      quoteId: 'QUOTE-100',
      currency: 'AUD',
      subtotal: 200,
      totalAmount: 220,
      items: [{ sku: 'SKU-100', name: 'Verified item', quantity: 2, unitPriceCents: 10000, totalPriceCents: 20000 }],
    },
  }, decision('trade.quote_create'), workspace, release);
  assert.equal(card(quoteResult, 'quote')?.props.totals.total, 220);
  assert.equal(card(quoteResult, 'products'), undefined, 'quote lines must not be misrendered as search results');

  const cartResult = port.compose({
    valid: true,
    outcome: {
      cart: {
        cartId: 'CART-100',
        currency: 'AUD',
        items: [{ sku: 'SKU-100', title: 'Verified item', quantity: 1, priceCents: 10000 }],
        totals: { subtotal: 100, total: 110, currency: 'AUD' },
      },
    },
  }, decision('cart.update'), workspace, release);
  assert.equal(card(cartResult, 'cart')?.props.lines[0].sku, 'SKU-100');

  const projectResult = port.compose({
    valid: true,
    outcome: {
      ok: true,
      projectType: 'merchant-authored-project',
      projectName: 'Verified project plan',
      pricingComplete: true,
      currency: 'AUD',
      total: 300,
      verifiedNotes: ['Verified project note.'],
      materials: [{
        sku: 'SKU-PLAN',
        title: 'Verified plan item',
        quantity: 3,
        unitPrice: 100,
        currency: 'AUD',
        catalogVerified: true,
        pricingVerified: true,
      }],
    },
  }, decision('projectPlan.build'), workspace, release);
  assert.equal(card(projectResult, 'bundle')?.props.items[0].sku, 'SKU-PLAN');

  const orderResult = port.compose({
    valid: true,
    outcome: {
      orderId: 'ORDER-100',
      status: 'pending_payment',
      currency: 'AUD',
      totalCents: 11000,
      createdAt: '2026-10-10T00:00:00.000Z',
    },
  }, decision('order.commit'), workspace, release);
  assert.equal(card(orderResult, 'order_confirmation')?.props.orderId, 'ORDER-100');
  assert.equal(card(orderResult, 'order_confirmation')?.props.total, 110);

  const noCardsRelease = JSON.parse(JSON.stringify(release));
  noCardsRelease.experience.cards.allowedCardTypes = [];
  const suppressed = port.compose({
    valid: true,
    outcome: {
      orderId: 'ORDER-BLOCKED',
      status: 'pending_payment',
      currency: 'AUD',
      totalCents: 100,
    },
  }, decision('order.commit'), workspace, noCardsRelease);
  assert.equal(suppressed.uiInstructions.length, 0, 'published card allow-list must control presentation');

  console.log('✅ End-to-end presentation contracts: 7 passed, 0 failed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
