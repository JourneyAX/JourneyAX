import assert from 'node:assert/strict';
import {
  NotificationDispatcher,
  NotificationRateLimitError,
} from '../src/notifications';

async function runNotificationTests() {
  console.log('🧪 Running Notification Dispatcher & Operational Tests in Agent 4...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      failed++;
    }
  }

  // In-memory mock database
  const insertedDeliveries: any[] = [];
  const insertedOutbox: any[] = [];
  const secretsCollection: any[] = [
    { tenantId: 'tenant_abc', secretRef: 'resend_secret_ref', value: 're_mock_12345' },
    { tenantId: 'tenant_abc', secretRef: 'webhook_secret_ref', value: 'wh_mock_secret_key' },
  ];

  const mockDb: any = {
    collection: (name: string) => {
      if (name === 'notification_deliveries') {
        return {
          insertOne: async (doc: any) => { insertedDeliveries.push(doc); return { acknowledged: true }; },
          find: (query: any) => ({
            sort: () => ({
              limit: (lim: number) => ({
                toArray: async () => insertedDeliveries.filter((d) => d.tenantId === query.tenantId).slice(0, lim),
              }),
            }),
          }),
          countDocuments: async (query: any) => {
            return insertedDeliveries.filter((d) => d.tenantId === query.tenantId).length;
          },
          updateOne: async (query: any, update: any) => {
            const item = insertedDeliveries.find((d) => d.deliveryId === query.deliveryId);
            if (item && update.$set) {
              Object.assign(item, update.$set);
            }
            return { matchedCount: item ? 1 : 0 };
          },
          findOne: async (query: any) => insertedDeliveries.find((d) => d.deliveryId === query.deliveryId) || null,
        };
      }
      if (name === 'outbox_events') {
        return {
          insertOne: async (doc: any) => { insertedOutbox.push(doc); return { acknowledged: true }; },
        };
      }
      if (name === 'tenant_secrets') {
        return {
          findOne: async (query: any) => secretsCollection.find((s) => s.tenantId === query.tenantId && s.secretRef === query.secretRef) || null,
        };
      }
      return {
        insertOne: async () => ({ acknowledged: true }),
        findOne: async () => null,
      };
    },
  };

  const dispatcher = new NotificationDispatcher(mockDb);

  // Test 1: Enqueue to outbox
  await test('enqueueToOutbox persists durable pending event', async () => {
    const eventId = await dispatcher.enqueueToOutbox('tenant_abc', 'production', 'order.paid', { orderId: 'ord_1' });
    assert.ok(eventId.startsWith('evt_outbox_'));
    assert.equal(insertedOutbox.length, 1);
    assert.equal(insertedOutbox[0].status, 'pending');
    assert.equal(insertedOutbox[0].tenantId, 'tenant_abc');
  });

  // Test 2: Multi-provider dispatch (SendGrid fails closed when no key configured)
  await test('dispatch fails closed with explicit error when email API key is missing', async () => {
    const res = await dispatcher.dispatch(
      'tenant_abc',
      'test.alert',
      { info: 'hello' },
      {
        email: {
          enabled: true,
          provider: 'sendgrid',
          defaultRecipients: ['admin@example.com'],
        },
      }
    );
    assert.equal(res.success, false);
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0].status, 'failed');
    assert.ok(res.deliveries[0].error?.includes('API key not configured'));
  });

  // Test 3: Secret reference resolution for Resend provider
  await test('dispatch resolves API key from database secret reference', async () => {
    // Intercept global fetch
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalled = true;
      assert.ok(init.headers['Authorization'].includes('re_mock_12345'));
      return {
        ok: true,
        status: 200,
        text: async () => '{"id":"msg_1"}',
      } as any;
    };

    try {
      const res = await dispatcher.dispatch(
        'tenant_abc',
        'order.placed',
        { orderId: 'ord_999' },
        {
          email: {
            enabled: true,
            provider: 'resend',
            apiKeyRef: 'resend_secret_ref',
            defaultRecipients: ['customer@example.com'],
          },
        }
      );
      assert.equal(fetchCalled, true);
      assert.equal(res.success, true);
      assert.equal(res.deliveries[0].status, 'delivered');
      assert.equal(res.deliveries[0].provider, 'resend');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 4: Rate limit enforcement
  await test('checkRateLimit throws NotificationRateLimitError when tenant threshold exceeded', async () => {
    // Current count is 2 delivered
    await assert.rejects(
      async () => {
        await dispatcher.checkRateLimit('tenant_abc', 2);
      },
      NotificationRateLimitError
    );
  });

  // Test 5: Approval notification dispatch
  await test('dispatchApprovalNotification dispatches human review alert with expiration and action URL', async () => {
    const approvalReq = {
      requestId: 'appr_req_101',
      toolId: 'order.commit',
      executionId: 'exec_555',
      parameters: { totalCents: 50000 },
      requestedBy: 'operator_1',
      expiresAt: new Date(Date.now() + 3600000),
    };

    const res = await dispatcher.dispatchApprovalNotification(
      'tenant_abc',
      approvalReq,
      {
        webhook: {
          enabled: true,
          url: 'https://approval-webhook.internal/test',
        },
      }
    );

    assert.equal(res.deliveries.length, 1);
    const deliv = insertedDeliveries.find((d) => d.eventId === 'execution.requires_approval');
    assert.ok(deliv);
    assert.equal(deliv.payload.requestId, 'appr_req_101');
    assert.ok(deliv.payload.actionUrl.includes('appr_req_101'));
  });

  // Test 6: Membership invite notification dispatch
  await test('dispatchMembershipInviteNotification creates invite email payload with token and accept URL', async () => {
    const invite = {
      email: 'newhire@example.com',
      fullName: 'Alice Smith',
      role: 'consultant',
      invitationToken: 'tok_alice_123',
      expiresAt: new Date(Date.now() + 86400000).toISOString(),
      invitedBy: 'admin_bob',
    };

    await dispatcher.dispatchMembershipInviteNotification(
      'tenant_abc',
      invite,
      {
        email: {
          enabled: true,
          provider: 'sendgrid',
        },
      }
    );

    const deliv = insertedDeliveries.find((d) => d.eventId === 'membership.invite');
    assert.ok(deliv);
    assert.equal(deliv.recipient, 'newhire@example.com');
    assert.ok(deliv.payload.inviteUrl.includes('tok_alice_123'));
  });

  // Test 7: Inbound webhook callback authentication & status updates
  await test('handleEmailWebhookCallback verifies HMAC signature and updates delivery status', async () => {
    const targetDeliv = insertedDeliveries[0];
    const callbackPayload = [
      {
        deliveryId: targetDeliv.deliveryId,
        event: 'bounced',
        reason: 'Mailbox full',
      },
    ];

    const secret = 'webhook_secret_key';
    const { createHmac } = await import('crypto');
    const hmac = createHmac('sha256', secret);
    hmac.update(JSON.stringify(callbackPayload));
    const sig = `sha256=${hmac.digest('hex')}`;

    const res = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-journeyax-signature': sig },
      callbackPayload,
      secret
    );

    assert.equal(res.processed, 1);
    assert.equal(targetDeliv.status, 'bounced');
  });

  console.log(`\nNotification Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runNotificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
