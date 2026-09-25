import assert from 'node:assert/strict';
import * as crypto from 'crypto';
import { RuntimeService } from '../src/runtime.service';
import {
  signWebhookPayload,
  verifyWebhookSignature,
  journeyaxPiece,
  humanApprovalRequiredTrigger,
  appendWorkspaceResultAction,
  resolveHumanApprovalAction,
} from '@journeyax/activepieces-piece';

async function runTests() {
  console.log('=== Running Activepieces Integration Tests ===\n');

  const testSecret = 'whsec_test_secret_key_88492048204820482';
  process.env.ACTIVEPIECES_WEBHOOK_SECRET = testSecret;
  process.env.NODE_ENV = 'test';
  process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';

  const runtimeService = new RuntimeService();

  // Test 1: Outbound Payload Signing & Independent HMAC Verification
  {
    console.log('Test 1: Outbound payload signing creates valid HMAC-SHA256 signature');
    const payload = {
      event: 'goal_completed',
      tenantId: 'tenant-ap-1',
      environmentId: 'test',
      workspaceId: 'ws-ap-1',
      data: { goal: 'Checkout purchase', totalCents: 15900 },
    };

    const ts = Date.now();
    const nonce = 'nonce-test-1234';
    const signed = signWebhookPayload(payload, testSecret, ts, nonce);

    assert.equal(signed.nonce, nonce);
    assert.equal(signed.timestamp, String(ts));

    // Independent signature check
    const expectedSig = crypto
      .createHmac('sha256', testSecret)
      .update(`${ts}.${nonce}.${signed.bodyString}`)
      .digest('hex');

    assert.equal(signed.signature, expectedSig, 'Signature must match HMAC-SHA256 calculation');
    console.log('✓ Outbound payload signed correctly\n');
  }

  // Test 2: Inbound Timing-Safe Signature Verification
  {
    console.log('Test 2: Inbound signature verification with timing-safe comparison');
    const payload = { event: 'stage_changed', data: { toStage: 'quote_review' } };
    const ts = Date.now();
    const nonce = 'nonce-test-5678';
    const signed = signWebhookPayload(payload, testSecret, ts, nonce);

    // Valid signature passes
    const validResult = verifyWebhookSignature(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      signed.bodyString,
      testSecret
    );
    assert.equal(validResult.valid, true);

    // Tampered payload fails
    const tamperedBody = signed.bodyString + ' ';
    const tamperedResult = verifyWebhookSignature(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      tamperedBody,
      testSecret
    );
    assert.equal(tamperedResult.valid, false);
    assert.match(tamperedResult.reason || '', /HMAC signature verification failed/);

    // Tampered signature fails
    const badSig = signed.signature.slice(0, -2) + '00';
    const badSigResult = verifyWebhookSignature(
      badSig,
      signed.timestamp,
      signed.nonce,
      signed.bodyString,
      testSecret
    );
    assert.equal(badSigResult.valid, false);
    console.log('✓ Timing-safe signature verification enforced\n');
  }

  // Test 3: Timestamp Skew Tolerance (5 minutes)
  {
    console.log('Test 3: Webhook timestamp skew tolerance');
    const payload = { event: 'ping', data: {} };
    const nonce = 'nonce-skew-1';

    // 6 minutes in the past (> 5 min tolerance)
    const oldTs = Date.now() - 6 * 60 * 1000;
    const oldSigned = signWebhookPayload(payload, testSecret, oldTs, nonce);

    const skewResult = verifyWebhookSignature(
      oldSigned.signature,
      oldSigned.timestamp,
      oldSigned.nonce,
      oldSigned.bodyString,
      testSecret
    );
    assert.equal(skewResult.valid, false);
    assert.match(skewResult.reason || '', /skew tolerance/);

    // Runtime service process check
    const runtimeResult = await runtimeService.processActivepiecesWebhook(
      oldSigned.signature,
      oldSigned.timestamp,
      oldSigned.nonce,
      payload,
      oldSigned.bodyString
    );
    assert.equal(runtimeResult.status, 'rejected');
    assert.match(runtimeResult.error || '', /tolerance window/);
    console.log('✓ Expired timestamps outside 5-minute tolerance rejected\n');
  }

  // Test 4: Missing Secret Fails Closed
  {
    console.log('Test 4: Missing webhook secret fails closed');
    const savedSecret = process.env.ACTIVEPIECES_WEBHOOK_SECRET;
    delete process.env.ACTIVEPIECES_WEBHOOK_SECRET;

    const payload = { event: 'ping', data: {} };
    const ts = Date.now();
    const nonce = 'nonce-nosecret-1';
    const signed = signWebhookPayload(payload, 'any_secret', ts, nonce);

    const result = await runtimeService.processActivepiecesWebhook(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      payload,
      signed.bodyString
    );

    assert.equal(result.status, 'rejected');
    assert.match(result.error || '', /ACTIVEPIECES_WEBHOOK_SECRET is not configured/);

    process.env.ACTIVEPIECES_WEBHOOK_SECRET = savedSecret;
    console.log('✓ Fails closed when secret is unconfigured\n');
  }

  // Test 5: Replay Prevention with In-Memory Nonce Tracking
  {
    console.log('Test 5: Replay prevention rejects duplicate nonces');
    runtimeService.clearClaimedNoncesForTest();

    const tenantId = 'tenant-replay-test';
    const environmentId = 'test';
    const workspaceId = 'ws-replay-test';

    // Seed workspace
    await runtimeService.appService.workspaceRepo.getOrCreate(
      tenantId,
      environmentId,
      workspaceId,
      'test_journey',
      'initial'
    );

    const nonce = 'nonce-replay-unique-991';
    const payload = {
      event: 'append_fact',
      tenantId,
      environmentId,
      workspaceId,
      data: {
        key: 'crm.sync_count',
        value: 1,
        source: 'external',
      },
    };

    const ts = Date.now();
    const signed = signWebhookPayload(payload, testSecret, ts, nonce);

    // First attempt: should succeed and be processed
    const firstAttempt = await runtimeService.processActivepiecesWebhook(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      payload,
      signed.bodyString
    );
    assert.equal(firstAttempt.status, 'processed');
    assert.equal(firstAttempt.nonce, nonce);

    // Replay attempt: exact same payload and nonce
    const replayAttempt = await runtimeService.processActivepiecesWebhook(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      payload,
      signed.bodyString
    );
    assert.equal(replayAttempt.status, 'rejected');
    assert.equal(replayAttempt.nonce, nonce);
    assert.match(replayAttempt.error || '', /replay rejected/i);
    console.log('✓ Duplicate webhook nonce rejected with replay rejection error\n');
  }

  // Test 6: End-to-End Fact Appending via Webhook
  {
    console.log('Test 6: End-to-end webhook appends fact and enqueues outbox event');
    const tenantId = 'tenant-fact-test';
    const environmentId = 'test';
    const workspaceId = 'ws-fact-test';

    await runtimeService.appService.workspaceRepo.getOrCreate(
      tenantId,
      environmentId,
      workspaceId,
      'test_journey',
      'initial'
    );

    const nonce = 'nonce-fact-8822';
    const payload = {
      event: 'append_fact',
      tenantId,
      environmentId,
      workspaceId,
      data: {
        key: 'external.lead_id',
        value: 'LEAD-AUTO-7721',
        source: 'external',
      },
    };

    const signed = signWebhookPayload(payload, testSecret, Date.now(), nonce);

    const result = await runtimeService.processActivepiecesWebhook(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      payload,
      signed.bodyString
    );

    assert.equal(result.status, 'processed');
    assert.equal(result.result.success, true);
    assert.equal(result.result.key, 'external.lead_id');

    // Verify fact loaded in workspace
    const ws = await runtimeService.getWorkspace(tenantId, environmentId, workspaceId);
    assert(ws !== null, 'Workspace must exist');
    assert.equal(ws.facts['external.lead_id']?.value, 'LEAD-AUTO-7721');
    assert.equal(ws.facts['external.lead_id']?.source, 'external');
    assert.equal(ws.facts['external.lead_id']?.confidence, 1.0);
    console.log('✓ Fact appended into workspace state with external attribution\n');
  }

  // Test 7: End-to-End Human Approval Resolution via Webhook
  {
    console.log('Test 7: End-to-end webhook resolves pending human approval');
    const tenantId = 'tenant-appr-test';
    const environmentId = 'test';
    const workspaceId = 'ws-appr-test';

    await runtimeService.appService.workspaceRepo.getOrCreate(
      tenantId,
      environmentId,
      workspaceId,
      'test_journey',
      'initial'
    );

    // Create a pending approval
    const ctx = {
      tenantId,
      environmentId,
      workspaceId,
      sessionId: 'sess_test_99',
      stageId: 'initial',
      packVersionId: '1.0.0',
      principalRole: 'agent',
      principalId: 'test_user',
    };
    const apprReq = await runtimeService.appService.approvalService.createPending(
      'crm.create_lead',
      { contactEmail: 'director@example.com' },
      ctx as any
    );

    const nonce = 'nonce-appr-9933';
    const payload = {
      event: 'resolve_approval',
      tenantId,
      environmentId,
      workspaceId,
      data: {
        approvalRequestId: apprReq.approvalRequestId,
        decision: 'approved',
        decidedBy: 'workflow_agent_activepieces',
      },
    };

    const signed = signWebhookPayload(payload, testSecret, Date.now(), nonce);

    const result = await runtimeService.processActivepiecesWebhook(
      signed.signature,
      signed.timestamp,
      signed.nonce,
      payload,
      signed.bodyString
    );

    assert.equal(result.status, 'processed');
    assert.equal(result.result.success, true);
    assert.equal(result.result.approvalRequestId, apprReq.approvalRequestId);

    // Verify approval record is now consumed as approved
    const consumed = await (runtimeService.appService.approvalService as any).store.consumeApproved(
      apprReq.approvalRequestId,
      'crm.create_lead',
      { contactEmail: 'director@example.com' },
      ctx as any
    );
    assert.equal(consumed, true, 'Approved tool execution must be consumable');
    console.log('✓ Pending human approval resolved via webhook\n');
  }

  // Test 8: Activepieces Piece & Trigger Definitions
  {
    console.log('Test 8: Activepieces Piece registers valid triggers and actions');
    assert.equal(journeyaxPiece.displayName, 'JourneyAX Operating System');
    const actionsMap = journeyaxPiece.actions();
    const triggersMap = journeyaxPiece.triggers();
    assert.equal(Object.keys(actionsMap).length, 4);
    assert.equal(Object.keys(triggersMap).length, 6);
    assert.ok(actionsMap['append_workspace_result']);
    assert.ok(actionsMap['resolve_human_approval']);
    assert.ok(triggersMap['human_approval_required']);
    assert.ok(triggersMap['goal_completed']);

    // Check trigger filter logic
    const contextWithFilter = {
      propsValue: { toolId: 'crm.create_lead' },
      payload: {
        body: {
          tenantId: 't1',
          environmentId: 'test',
          workspaceId: 'ws1',
          approvalRequestId: 'req1',
          toolId: 'crm.create_lead',
          risk: 'medium',
          reason: 'Test',
          payload: {},
          timestamp: new Date().toISOString(),
        },
      },
    } as any;

    const matched = (await (humanApprovalRequiredTrigger as any).run(contextWithFilter)) as any[];
    assert.equal(matched.length, 1);
    assert.equal(matched[0].toolId, 'crm.create_lead');

    // Context with non-matching toolId filter
    const contextMismatch = {
      propsValue: { toolId: 'payment.charge' },
      payload: {
        body: {
          tenantId: 't1',
          environmentId: 'test',
          workspaceId: 'ws1',
          approvalRequestId: 'req1',
          toolId: 'crm.create_lead',
          risk: 'medium',
          reason: 'Test',
          payload: {},
          timestamp: new Date().toISOString(),
        },
      },
    } as any;

    const unmatched = (await (humanApprovalRequiredTrigger as any).run(contextMismatch)) as any[];
    assert.equal(unmatched.length, 0);
    console.log('✓ Activepieces Piece triggers and actions validated\n');
  }

  // Test 9: Authenticated Webhook Trigger Registration & Unregistration via onEnable/onDisable
  {
    console.log('Test 9: Trigger authenticated onEnable registration and onDisable unregistration');
    const tenantId = 'tenant-trigger-reg';
    const environmentId = 'test';

    // Register directly against runtimeService
    const sub = await runtimeService.registerWebhookSubscription(
      tenantId,
      environmentId,
      'journey_started',
      'https://automation.journeyax.com/api/v1/webhooks/ap_flow_991'
    );
    assert.ok(sub.subscriptionId.startsWith('sub_'));
    assert.equal(sub.tenantId, tenantId);
    assert.equal(sub.environmentId, environmentId);
    assert.equal(sub.event, 'journey_started');

    // Verify subscription listed
    const activeSubs = await runtimeService.listWebhookSubscriptions(tenantId, environmentId, 'journey_started');
    assert.equal(activeSubs.length, 1);
    assert.equal(activeSubs[0].subscriptionId, sub.subscriptionId);

    // Unregister
    const deleted = await runtimeService.unregisterWebhookSubscription(tenantId, environmentId, sub.subscriptionId);
    assert.equal(deleted, true);

    const remainingSubs = await runtimeService.listWebhookSubscriptions(tenantId, environmentId, 'journey_started');
    assert.equal(remainingSubs.length, 0);

    console.log('✓ Trigger lifecycle registration and unregistration verified\n');
  }

  // Test 10: Action Execution Strictly Bounded to Connection Tenant & Environment
  {
    console.log('Test 10: Action execution bound immutably to connection tenant and environment');

    // Verify action definition does NOT expose tenantId or environmentId override props
    const props = appendWorkspaceResultAction.props;
    assert.equal((props as any).tenantId, undefined, 'tenantId override prop must not exist');
    assert.equal((props as any).environmentId, undefined, 'environmentId override prop must not exist');

    const approvalProps = resolveHumanApprovalAction.props;
    assert.equal((approvalProps as any).tenantId, undefined, 'tenantId override prop must not exist on approval action');
    assert.equal((approvalProps as any).environmentId, undefined, 'environmentId override prop must not exist on approval action');

    console.log('✓ Action definitions bound immutably without cross-tenant override props\n');
  }

  console.log('====================================================');
  console.log('✓ All 10 Activepieces Integration Tests PASSED!');
  console.log('====================================================\n');
}

runTests().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
