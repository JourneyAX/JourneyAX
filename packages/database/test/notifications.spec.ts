import assert from 'node:assert/strict';
import { createHmac } from 'crypto';
import {
  NotificationDispatcher,
  NotificationRateLimitError,
} from '../src/notifications';

async function runNotificationTests() {
  console.log('🧪 Running Comprehensive Notification Security & Durability Tests (Workstream B)...\n');

  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void> | void) {
    try {
      await fn();
      console.log(`  ✅ PASS: ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ❌ FAIL: ${name}: ${err.message}`);
      console.error(err.stack);
      failed++;
    }
  }

  // In-memory mock database
  const insertedDeliveries: any[] = [];
  const insertedOutbox: any[] = [];
  const insertedSuppressions: any[] = [];
  const insertedCallbacks: any[] = [];
  const secretsCollection: any[] = [
    { tenantId: 'tenant_abc', secretRef: 'resend_secret_ref', value: 're_mock_12345' },
    { tenantId: 'tenant_abc', secretRef: 'webhook_secret_ref', value: 'wh_mock_secret_key' },
    { tenantId: 'tenant_abc', secretRef: 'activepieces_webhook_secret', value: 'wh_ap_secret_key' },
    { tenantId: 'tenant_xyz', secretRef: 'xyz_secret_ref', value: 'xyz_private_key' },
  ];
  const connectionsCollection: any[] = [
    { tenantId: 'tenant_abc', environmentId: 'production', connectionRef: 'conn_ap_valid' },
  ];

  const mockDb: any = {
    collection: (name: string) => {
      if (name === 'notification_deliveries') {
        return {
          insertOne: async (doc: any) => {
            insertedDeliveries.push(doc);
            return { acknowledged: true };
          },
          find: (query: any) => ({
            sort: () => ({
              limit: (lim: number) => ({
                toArray: async () =>
                  insertedDeliveries.filter((d) => !query.tenantId || d.tenantId === query.tenantId).slice(0, lim),
              }),
            }),
          }),
          countDocuments: async (query: any) => {
            return insertedDeliveries.filter((d) => d.tenantId === query.tenantId).length;
          },
          updateOne: async (query: any, update: any) => {
            const item = insertedDeliveries.find((d) => {
              if (query.tenantId && d.tenantId !== query.tenantId) return false;
              if (query.environmentId && d.environmentId !== query.environmentId) return false;
              if (query.$or) {
                return query.$or.some((cond: any) => {
                  if (cond.deliveryId && d.deliveryId === cond.deliveryId) return true;
                  if (cond.providerDeliveryId && d.providerDeliveryId === cond.providerDeliveryId) return true;
                  return false;
                });
              }
              if (query.deliveryId) return d.deliveryId === query.deliveryId;
              return false;
            });
            if (item && update.$set) {
              Object.assign(item, update.$set);
              return { matchedCount: 1, modifiedCount: 1 };
            }
            return { matchedCount: item ? 1 : 0, modifiedCount: 0 };
          },
          findOne: async (query: any) => {
            return (
              insertedDeliveries.find((d) => {
                if (query.tenantId && d.tenantId !== query.tenantId) return false;
                if (query.environmentId && d.environmentId !== query.environmentId) return false;
                if (query.$or) {
                  return query.$or.some((cond: any) => {
                    if (cond.deliveryId && d.deliveryId === cond.deliveryId) return true;
                    if (cond.providerDeliveryId && d.providerDeliveryId === cond.providerDeliveryId) return true;
                    return false;
                  });
                }
                if (query.deliveryId) return d.deliveryId === query.deliveryId;
                return false;
              }) || null
            );
          },
        };
      }
      if (name === 'outbox_events') {
        return {
          insertOne: async (doc: any) => {
            insertedOutbox.push(doc);
            return { acknowledged: true };
          },
        };
      }
      if (name === 'tenant_secrets') {
        return {
          findOne: async (query: any) =>
            secretsCollection.find((s) => s.tenantId === query.tenantId && s.secretRef === query.secretRef) || null,
        };
      }
      if (name === 'tenant_connections') {
        return {
          findOne: async (query: any) =>
            connectionsCollection.find(
              (c) =>
                c.tenantId === query.tenantId &&
                c.environmentId === query.environmentId &&
                c.connectionRef === query.connectionRef
            ) || null,
        };
      }
      if (name === 'notification_suppressions') {
        return {
          findOne: async (query: any) =>
            insertedSuppressions.find(
              (s) =>
                s.tenantId === query.tenantId &&
                s.environmentId === query.environmentId &&
                s.recipient.toLowerCase() === (query.recipient || '').toLowerCase()
            ) || null,
          updateOne: async (query: any, update: any, opts: any) => {
            let item = insertedSuppressions.find(
              (s) =>
                s.tenantId === query.tenantId &&
                s.environmentId === query.environmentId &&
                s.recipient.toLowerCase() === (query.recipient || '').toLowerCase()
            );
            if (!item && opts?.upsert) {
              item = { ...query, ...update.$set, ...update.$setOnInsert };
              insertedSuppressions.push(item);
              return { matchedCount: 0, upsertedCount: 1 };
            }
            if (item && update.$set) {
              Object.assign(item, update.$set);
              return { matchedCount: 1, modifiedCount: 1 };
            }
            return { matchedCount: item ? 1 : 0 };
          },
        };
      }
      if (name === 'notification_callbacks') {
        return {
          findOne: async (query: any) =>
            insertedCallbacks.find((c) => c.callbackId === query.callbackId) || null,
          insertOne: async (doc: any) => {
            insertedCallbacks.push(doc);
            return { acknowledged: true };
          },
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
  await test('1. enqueueToOutbox persists durable pending event', async () => {
    const eventId = await dispatcher.enqueueToOutbox('tenant_abc', 'production', 'order.paid', { orderId: 'ord_1' });
    assert.ok(eventId.startsWith('evt_outbox_'));
    assert.equal(insertedOutbox.length, 1);
    assert.equal(insertedOutbox[0].status, 'pending');
    assert.equal(insertedOutbox[0].tenantId, 'tenant_abc');
  });

  // Test 2: Unavailable provider / no global environment fallback (Negative)
  await test('2. Negative: Dispatch fails closed without falling back to global process.env keys', async () => {
    const origKey = process.env.SENDGRID_API_KEY;
    process.env.SENDGRID_API_KEY = 'SG.global_forbidden_fallback_key';

    try {
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
      assert.match(res.deliveries[0].error || '', /no valid tenant secret found/i);
    } finally {
      if (origKey !== undefined) {
        process.env.SENDGRID_API_KEY = origKey;
      } else {
        delete process.env.SENDGRID_API_KEY;
      }
    }
  });

  // Test 3: Secret reference resolution for Resend provider
  await test('3. dispatch resolves API key from database tenant-scoped secret reference and persists typed details', async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = async (url: any, init: any) => {
      fetchCalled = true;
      assert.ok(init.headers['Authorization'].includes('re_mock_12345'));
      return {
        ok: true,
        status: 200,
        json: async () => ({ id: 'resend_msg_999' }),
        text: async () => '{"id":"resend_msg_999"}',
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

      // Verify typed persistence
      const saved = insertedDeliveries.find((d) => d.eventId === 'order.placed');
      assert.ok(saved);
      assert.equal(saved.tenantId, 'tenant_abc');
      assert.equal(saved.recipient, 'customer@example.com');
      assert.equal(saved.routingDecision.channel, 'email');
      assert.equal(saved.routingDecision.provider, 'resend');
      assert.ok(saved.deduplicationKey);
      assert.equal(saved.attempts, 1);
      assert.equal(saved.maxAttempts, 3);
      assert.ok(saved.retrySchedule);
      assert.equal(saved.providerDeliveryId, 'resend_msg_999');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 4: Rate limit enforcement
  await test('4. checkRateLimit throws NotificationRateLimitError when tenant threshold exceeded', async () => {
    await assert.rejects(
      async () => {
        await dispatcher.checkRateLimit('tenant_abc', 1);
      },
      NotificationRateLimitError
    );
  });

  // Test 5: Negative Cross-Tenant secret access rejection
  await test('5. Negative Cross-Tenant: Tenant ABC cannot resolve Tenant XYZ secret', async () => {
    const secret = await dispatcher.resolveSecret('tenant_abc', 'xyz_secret_ref');
    assert.equal(secret, null, 'Cross-tenant secret resolution must fail closed');
  });

  // Test 6: Activepieces dispatch via CapabilityDispatcher (never treated as a URL)
  await test('6. Activepieces notification dispatches via capability dispatcher with connection ownership', async () => {
    let mockDispatcherInvoked = false;
    const mockCapabilityDispatcher: any = {
      dispatch: async (tool: any, binding: any, request: any, ctx: any) => {
        mockDispatcherInvoked = true;
        assert.equal(binding.tenantId, 'tenant_abc');
        assert.equal(binding.executor.connectionRef, 'conn_ap_valid');
        assert.equal(ctx.tenantId, 'tenant_abc');
        return {
          toolId: tool.toolId,
          status: 'success',
          output: { deliveryId: 'ap_run_789' },
          provenance: { correlationId: ctx.correlationId },
        };
      },
    };

    const apDispatcher = new NotificationDispatcher(mockDb, {
      capabilityDispatcher: mockCapabilityDispatcher,
    });

    const res = await apDispatcher.dispatch(
      'tenant_abc',
      'workflow.triggered',
      { data: 'abc' },
      {
        email: {
          enabled: true,
          provider: 'activepieces',
          connectionRef: 'conn_ap_valid',
          defaultRecipients: ['lead@example.com'],
        },
      }
    );

    assert.equal(mockDispatcherInvoked, true);
    assert.equal(res.success, true);
    assert.equal(res.deliveries[0].status, 'delivered');
    assert.equal(res.deliveries[0].providerDeliveryId, 'ap_run_789');
  });

  // Test 7: Negative Unsigned webhook rejected
  await test('7. Negative Unsigned Webhook: Missing or invalid signature throws error', async () => {
    const callbackPayload = [{ deliveryId: 'deliv_1', event: 'delivered' }];

    // Missing signature
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'generic',
          {},
          callbackPayload,
          'secret_key'
        );
      },
      /Missing webhook signature/i
    );

    // Invalid signature
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'generic',
          { 'x-journeyax-signature': 'sha256=invaliddeadbeef' },
          callbackPayload,
          'secret_key'
        );
      },
      /Invalid webhook callback signature/i
    );
  });

  // Test 8: Webhook callback updates delivery, deduplicates, and records bounce suppression
  await test('8. Webhook callback verifies HMAC, updates delivery, deduplicates, and records bounce suppression', async () => {
    const targetDeliv = insertedDeliveries.find((d) => d.eventId === 'order.placed');
    assert.ok(targetDeliv);

    const secret = 'wh_mock_secret_key';
    const callbackPayload = [
      {
        deliveryId: targetDeliv.deliveryId,
        event: 'bounced',
        email: targetDeliv.recipient,
        reason: '550 User unknown',
      },
    ];

    const hmac = createHmac('sha256', secret);
    hmac.update(JSON.stringify(callbackPayload));
    const sig = `sha256=${hmac.digest('hex')}`;

    // First call: successfully processed
    const res1 = await dispatcher.handleEmailWebhookCallback(
      'resend',
      { 'x-journeyax-signature': sig },
      callbackPayload,
      {
        secretRef: 'webhook_secret_ref',
        tenantId: 'tenant_abc',
        environmentId: 'production',
      }
    );

    assert.equal(res1.processed, 1);
    assert.equal(targetDeliv.status, 'bounced');

    // Verify bounce recorded in suppression collection
    const suppressed = await dispatcher.isSuppressed('tenant_abc', 'production', targetDeliv.recipient);
    assert.equal(suppressed, true, 'Bounced recipient must be added to suppressions');

    // Subsequent dispatch to this recipient must fail due to suppression
    const blockedRes = await dispatcher.dispatch(
      'tenant_abc',
      'invoice.sent',
      { amount: 100 },
      {
        email: {
          enabled: true,
          provider: 'resend',
          apiKeyRef: 'resend_secret_ref',
          defaultRecipients: [targetDeliv.recipient],
        },
      }
    );
    assert.equal(blockedRes.deliveries[0].status, 'failed');
    assert.match(blockedRes.deliveries[0].error || '', /actively suppressed/i);

    // Second call: duplicate callback
    const res2 = await dispatcher.handleEmailWebhookCallback(
      'resend',
      { 'x-journeyax-signature': sig },
      callbackPayload,
      {
        secretRef: 'webhook_secret_ref',
        tenantId: 'tenant_abc',
        environmentId: 'production',
      }
    );

    assert.equal(res2.processed, 0, 'Duplicate callback must not be processed again');
    assert.ok(res2.errors.some((e) => e.includes('Duplicate callback detected')));
  });

  // Test 9: Negative Cross-Tenant Webhook Callback Isolation
  await test('9. Negative Cross-Tenant Callback: Tenant XYZ cannot update delivery belonging to Tenant ABC', async () => {
    const targetDeliv = insertedDeliveries.find((d) => d.eventId === 'order.placed');
    assert.ok(targetDeliv);

    const secret = 'xyz_private_key';
    const callbackPayload = [
      {
        deliveryId: targetDeliv.deliveryId, // ABC's deliveryId
        event: 'delivered',
      },
    ];

    const hmac = createHmac('sha256', secret);
    hmac.update(JSON.stringify(callbackPayload));
    const sig = `sha256=${hmac.digest('hex')}`;

    // Tenant XYZ tries to update ABC's delivery
    const res = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-journeyax-signature': sig },
      callbackPayload,
      {
        secretRef: 'xyz_secret_ref',
        tenantId: 'tenant_xyz',
        environmentId: 'production',
      }
    );

    assert.equal(res.processed, 0, 'Must not process cross-tenant update');
    assert.ok(res.errors.some((e) => e.includes('No matching delivery record found for tenant \'tenant_xyz\'')));
  });

  // Test 10: Real Email Retry and Retry Exhaustion
  await test('10. Email retry performs real send and exhausts retries upon persistent failures', async () => {
    // Insert a failed delivery for retrying
    const failedDelivId = 'deliv_retry_test_1';
    insertedDeliveries.push({
      deliveryId: failedDelivId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'test.retry',
      channel: 'email',
      provider: 'resend',
      recipient: 'valid_retry_user@example.com',
      status: 'failed',
      attempts: 1,
      maxAttempts: 3,
      payload: { test: true },
      retrySchedule: { backoffMs: 1000, maxRetries: 3 },
      createdAt: new Date(),
    });

    const originalFetch = globalThis.fetch;
    let attemptsCount = 0;

    // Simulate persistent provider failure
    globalThis.fetch = async () => {
      attemptsCount++;
      return {
        ok: false,
        status: 503,
        text: async () => 'Service Unavailable',
      } as any;
    };

    try {
      // Retry attempt 1 -> total attempts 2 (retrying)
      const afterRetry1 = await dispatcher.retryDelivery(failedDelivId, {
        email: { enabled: true, apiKeyRef: 'resend_secret_ref' },
      });
      assert.equal(afterRetry1?.attempts, 2);
      assert.equal(afterRetry1?.status, 'retrying');
      assert.match(afterRetry1?.error || '', /503/);

      // Retry attempt 2 -> total attempts 3 >= maxAttempts 3 (failed - exhausted!)
      const afterRetry2 = await dispatcher.retryDelivery(failedDelivId, {
        email: { enabled: true, apiKeyRef: 'resend_secret_ref' },
      });
      assert.equal(afterRetry2?.attempts, 3);
      assert.equal(afterRetry2?.status, 'failed', 'Status must transition to failed upon retry exhaustion');
      assert.equal(afterRetry2?.deliveredAt, undefined, 'Must NEVER mark delivered without successful send');
      assert.equal(attemptsCount, 2, 'Must have performed real network attempts');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  console.log(`\nNotification Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runNotificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
