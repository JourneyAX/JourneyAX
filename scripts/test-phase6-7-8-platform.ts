import { config } from 'dotenv';
import * as path from 'path';
config({ path: path.resolve(__dirname, '../.env') });

import * as crypto from 'crypto';
import { RuntimeService } from '../apps/journey-runtime-service/src/runtime.service';
import { ModelRouter } from '../apps/journey-runtime-service/src/model/model-router';
import { BusinessPackLoader } from '../packages/business-pack/src/loader';
import { CARD_TYPES } from '@journeyax/ui-cards';
import { uiActionToCards } from '../apps/journeyax-web/src/lib/cards/uiActionToCards';

async function main() {
  console.log('========================================================================');
  console.log('🧪 RUNNING PHASE 6, 7 & 8 AUTOMATED VALIDATION SUITE');
  console.log('========================================================================\n');

  const runtimeService = new RuntimeService();
  const modelRouter = new ModelRouter();
  const packLoader = new BusinessPackLoader({
    localPacksRoot: path.resolve(__dirname, '../packs'),
  });

  // ---------------------------------------------------------------------------
  // TEST 1: Policy-Driven Model Selection (Phase 8)
  // ---------------------------------------------------------------------------
  console.log('--- TEST 1: Policy-Driven Model Selection (Phase 8) ---');
  const wwgRelease = await packLoader.loadPublished('workweargroup', 'production');

  const fastModelRoute = modelRouter.resolveModel('fast_intent', wwgRelease);
  console.log(`[ModelRouter:fast_intent]: policy=${fastModelRoute.policyId}, provider=${fastModelRoute.provider}, model=${fastModelRoute.model}, dataResidency=${fastModelRoute.dataResidency}`);
  if (fastModelRoute.policyId !== 'fast_intent' || fastModelRoute.model !== 'gpt-4o-mini') {
    throw new Error(`Expected fast_intent policy with gpt-4o-mini, got ${fastModelRoute.policyId}/${fastModelRoute.model}`);
  }

  const complexModelRoute = modelRouter.resolveModel('complex_reasoning', wwgRelease);
  console.log(`[ModelRouter:complex_reasoning]: policy=${complexModelRoute.policyId}, provider=${complexModelRoute.provider}, model=${complexModelRoute.model}, dataResidency=${complexModelRoute.dataResidency}`);
  if (complexModelRoute.policyId !== 'complex_reasoning') {
    throw new Error(`Expected complex_reasoning policy, got ${complexModelRoute.policyId}`);
  }

  // Verify rejection when data residency cannot be satisfied and fallback prohibited
  let residencyErrorCaught = false;
  try {
    modelRouter.resolveModel('fast_intent', {
      ...wwgRelease,
      modelPolicy: {
        ...wwgRelease.modelPolicy,
        policies: [
          {
            ...wwgRelease.modelPolicy.policies[0],
            dataResidency: 'eu',
            fallbackAllowed: false,
          },
        ],
      },
    }, { targetDataResidency: 'us' });
  } catch (err: any) {
    residencyErrorCaught = true;
    console.log(`[ModelRouter] Rejection verified for data residency conflict: "${err.message}"`);
  }
  if (!residencyErrorCaught) {
    throw new Error('Expected data residency mismatch to throw explicit error!');
  }
  console.log('✅ TEST 1 (Policy-Driven Model Selection) PASSED!\n');

  // ---------------------------------------------------------------------------
  // TEST 2: Activepieces Webhook Security & Idempotency (Phase 6)
  // ---------------------------------------------------------------------------
  console.log('--- TEST 2: Activepieces Webhook Security & Idempotency (Phase 6) ---');
  const secret = process.env.ACTIVEPIECES_WEBHOOK_SECRET || 'journeyax_secret_key';
  const testWorkspaceId = `ws_test_ap_${Date.now()}`;

  // First, initialize workspace with a turn
  await runtimeService.runTurn({
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: testWorkspaceId,
    sessionId: testWorkspaceId,
    correlationId: `corr_init_${Date.now()}`,
    message: 'Hello, I am testing workspace initialization.',
  });

  // Prepare webhook payload to append an external CRM lead result
  const nonce = `nonce_${crypto.randomUUID()}`;
  const timestamp = Date.now().toString();
  const webhookPayload = {
    event: 'external_result',
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: testWorkspaceId,
    data: {
      key: 'crm_lead_id',
      value: 'LEAD-998822',
      source: 'activepieces',
    },
  };
  const stringBody = JSON.stringify(webhookPayload);
  const signature = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${nonce}.${stringBody}`)
    .digest('hex');

  // 2a: Test valid webhook execution
  const webhookResult = await runtimeService.processActivepiecesWebhook(
    signature,
    timestamp,
    nonce,
    webhookPayload,
    stringBody
  );
  console.log(`[Activepieces Webhook Processed]: status=${webhookResult.status}, nonce=${webhookResult.nonce}`);
  if (webhookResult.status !== 'processed') {
    throw new Error(`Expected status 'processed', got '${webhookResult.status}'`);
  }

  // Verify the fact was appended to the workspace
  const updatedWs = await runtimeService.getWorkspace('workweargroup', 'production', testWorkspaceId);
  if (!updatedWs || updatedWs.facts['crm_lead_id']?.value !== 'LEAD-998822') {
    throw new Error('Appended fact crm_lead_id not found in workspace!');
  }
  console.log(`[Workspace State]: verified crm_lead_id="${updatedWs.facts['crm_lead_id'].value}" source="${updatedWs.facts['crm_lead_id'].source}"`);

  // 2b: Test replay prevention / idempotency with same nonce
  const replayResult = await runtimeService.processActivepiecesWebhook(
    signature,
    timestamp,
    nonce,
    webhookPayload,
    stringBody
  );
  console.log(`[Activepieces Webhook Replay]: status=${replayResult.status} (idempotent duplicate rejected)`);
  if (replayResult.status !== 'already_processed') {
    throw new Error(`Expected replay status 'already_processed', got '${replayResult.status}'`);
  }

  // 2c: Test expired timestamp rejection
  const expiredTimestamp = (Date.now() - 10 * 60 * 1000).toString(); // 10 minutes ago
  const expiredSig = crypto
    .createHmac('sha256', secret)
    .update(`${expiredTimestamp}.${nonce}.${stringBody}`)
    .digest('hex');
  const expiredResult = await runtimeService.processActivepiecesWebhook(
    expiredSig,
    expiredTimestamp,
    `nonce_expired_${Date.now()}`,
    webhookPayload,
    stringBody
  );
  console.log(`[Activepieces Webhook Expired]: status=${expiredResult.status}, error="${expiredResult.error}"`);
  if (expiredResult.status !== 'rejected') {
    throw new Error('Expected expired timestamp to be rejected!');
  }

  // 2d: Test invalid HMAC signature rejection
  const invalidSigResult = await runtimeService.processActivepiecesWebhook(
    '0000000000000000000000000000000000000000000000000000000000000000',
    timestamp,
    `nonce_invalid_${Date.now()}`,
    webhookPayload,
    stringBody
  );
  console.log(`[Activepieces Webhook Invalid Sig]: status=${invalidSigResult.status}, error="${invalidSigResult.error}"`);
  if (invalidSigResult.status !== 'rejected') {
    throw new Error('Expected invalid HMAC signature to be rejected!');
  }
  console.log('✅ TEST 2 (Activepieces Webhook Security & Idempotency) PASSED!\n');

  // ---------------------------------------------------------------------------
  // TEST 3: UI Cards Platform & Single Streaming Envelope (Phase 7)
  // ---------------------------------------------------------------------------
  console.log('--- TEST 3: UI Cards Platform & Single Streaming Envelope (Phase 7) ---');
  const turnResult = await runtimeService.runTurn({
    tenantId: 'workweargroup',
    environmentId: 'production',
    workspaceId: `ws_card_${Date.now()}`,
    sessionId: `sess_card_${Date.now()}`,
    correlationId: `corr_card_${Date.now()}`,
    message: 'I’m an apprentice electrician. I need lightweight summer pants and composite-toe boots under $250 AUD',
  });

  const bundleInstruction = turnResult.uiInstructions.find((i) => i.component === 'bundle');
  if (!bundleInstruction) {
    throw new Error('Expected bundle UI instruction to be generated');
  }

  // Verify single streaming envelope format
  if (!bundleInstruction.envelope || bundleInstruction.envelope.name !== 'presentCard') {
    throw new Error(`Expected envelope name 'presentCard', got ${bundleInstruction.envelope?.name}`);
  }
  const envelopeCard = bundleInstruction.envelope.arguments.card;
  console.log(`[Streaming Envelope Card]: id=${envelopeCard.id}, cardType=${envelopeCard.cardType}`);
  if (envelopeCard.cardType !== 'bundle') {
    throw new Error(`Expected cardType 'bundle', got ${envelopeCard.cardType}`);
  }

  // Verify schema validation against @journeyax/ui-cards CARD_TYPES
  const cardValidation = CARD_TYPES.bundle.state.safeParse(envelopeCard.state);
  if (!cardValidation.success) {
    throw new Error(`Card state failed schema validation: ${cardValidation.error.message}`);
  }
  console.log(`[UI Cards Validation]: bundle state strictly validated against CARD_TYPES.bundle.state`);

  // Verify client-side storefront parser converts presentCard envelope into CardInstance
  const storefrontCards = uiActionToCards({
    name: 'presentCard',
    arguments: {
      card: envelopeCard,
    },
  });
  console.log(`[Storefront uiActionToCards]: parsed ${storefrontCards.length} CardInstance for PUSH_CARD: id=${storefrontCards[0]?.id}`);
  if (storefrontCards.length !== 1 || storefrontCards[0].cardType !== 'bundle') {
    throw new Error('Storefront uiActionToCards failed to parse presentCard envelope');
  }
  console.log('✅ TEST 3 (UI Cards Platform & Single Streaming Envelope) PASSED!\n');

  console.log('========================================================================');
  console.log('🎉 ALL PHASE 6, 7 & 8 AUTOMATED VALIDATION ASSERTIONS PASSED!');
  console.log('========================================================================');
}

main().catch((err) => {
  console.error('❌ Validation failed:', err);
  process.exit(1);
});
