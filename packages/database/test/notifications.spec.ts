import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createSign } from 'crypto';
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
    { tenantId: 'tenant_abc', environmentId: 'production', secretRef: 'resend_secret_ref', value: 're_mock_12345' },
    { tenantId: 'tenant_abc', environmentId: 'production', secretRef: 'webhook_secret_ref', value: 'wh_mock_secret_key' },
    { tenantId: 'tenant_abc', environmentId: 'production', secretRef: 'activepieces_webhook_secret', value: 'wh_ap_secret_key' },
    { tenantId: 'tenant_xyz', environmentId: 'production', secretRef: 'xyz_secret_ref', value: 'xyz_private_key' },
    { tenantId: 'tenant_abc', environmentId: 'staging', secretRef: 'staging_only_secret', value: 'staging_secret_val' },
    { tenantId: 'tenant_svix', environmentId: 'production', secretRef: 'svix_secret_ref', value: 'whsec_54B3p6e5a6r2h3v5a4s5b6c7d8e9f0a1b2c3d4e5f6g=' },
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
              if (query.provider && d.provider !== query.provider) return false;
              if (query.$or) {
                const matches = query.$or.some((cond: any) => {
                  if (cond.deliveryId && d.deliveryId === cond.deliveryId) return true;
                  if (cond.providerDeliveryId && d.providerDeliveryId === cond.providerDeliveryId) return true;
                  return false;
                });
                if (!matches) return false;
              }
              if (query.$nor) {
                const matchesNor = query.$nor.some((cond: any) => {
                  return cond.status === d.status && cond['metadata.callbackEvent'] === d.metadata?.callbackEvent;
                });
                if (matchesNor) return false;
              }
              if (query.deliveryId && d.deliveryId !== query.deliveryId) return false;
              return true;
            });
            if (item && update.$set) {
              for (const [key, val] of Object.entries(update.$set)) {
                if (key.includes('.')) {
                  const parts = key.split('.');
                  let target = item;
                  for (let i = 0; i < parts.length - 1; i++) {
                    target[parts[i]] = target[parts[i]] || {};
                    target = target[parts[i]];
                  }
                  target[parts[parts.length - 1]] = val;
                } else {
                  item[key] = val;
                }
              }
              return { matchedCount: 1, modifiedCount: 1 };
            }
            return { matchedCount: item ? 1 : 0, modifiedCount: 0 };
          },
          findOne: async (query: any) => {
            return (
              insertedDeliveries.find((d) => {
                if (query.tenantId && d.tenantId !== query.tenantId) return false;
                if (query.environmentId && d.environmentId !== query.environmentId) return false;
                if (query.provider && d.provider !== query.provider) return false;
                if (query.$or) {
                  return query.$or.some((cond: any) => {
                    if (cond.deliveryId && d.deliveryId === cond.deliveryId) return true;
                    if (cond.providerDeliveryId && d.providerDeliveryId === cond.providerDeliveryId) return true;
                    return false;
                  });
                }
                if (query.deliveryId) return d.deliveryId === query.deliveryId;
                return true;
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
            secretsCollection.find(
              (s) =>
                s.tenantId === query.tenantId &&
                s.environmentId === query.environmentId &&
                s.secretRef === query.secretRef
            ) || null,
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
          updateOne: async (query: any, update: any, opts: any) => {
            let item = insertedCallbacks.find((c) => c.callbackId === query.callbackId);
            if (!item && opts?.upsert) {
              item = { ...query, ...update.$set };
              insertedCallbacks.push(item);
              return { matchedCount: 0, upsertedCount: 1 };
            }
            if (item && update.$set) {
              Object.assign(item, update.$set);
              return { matchedCount: 1, modifiedCount: 1 };
            }
            return { matchedCount: item ? 1 : 0 };
          },
          deleteOne: async (query: any) => {
            const idx = insertedCallbacks.findIndex((c) => c.callbackId === query.callbackId);
            if (idx >= 0) {
              insertedCallbacks.splice(idx, 1);
              return { deletedCount: 1 };
            }
            return { deletedCount: 0 };
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
    const secret = await dispatcher.resolveSecret('tenant_abc', 'production', 'xyz_secret_ref');
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

    const svixId = 'msg_svix_test_08';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const content = `${svixId}.${svixTimestamp}.${JSON.stringify(callbackPayload)}`;
    const svixSig = createHmac('sha256', Buffer.from(secret, 'utf-8')).update(content).digest('base64');
    const svixHeaders = {
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': `v1,${svixSig}`,
    };

    // First call: successfully processed
    const res1 = await dispatcher.handleEmailWebhookCallback(
      'resend',
      svixHeaders,
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
      svixHeaders,
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
      const afterRetry1 = await dispatcher.retryDelivery(
        'tenant_abc',
        'production',
        'resend',
        failedDelivId,
        {
          email: { enabled: true, apiKeyRef: 'resend_secret_ref' },
        }
      );
      assert.equal(afterRetry1?.attempts, 2);
      assert.equal(afterRetry1?.status, 'retrying');
      assert.match(afterRetry1?.error || '', /503/);

      // Retry attempt 2 -> total attempts 3 >= maxAttempts 3 (failed - exhausted!)
      const afterRetry2 = await dispatcher.retryDelivery(
        'tenant_abc',
        'production',
        'resend',
        failedDelivId,
        {
          email: { enabled: true, apiKeyRef: 'resend_secret_ref' },
        }
      );
      assert.equal(afterRetry2?.attempts, 3);
      assert.equal(afterRetry2?.status, 'failed', 'Status must transition to failed upon retry exhaustion');
      assert.equal(afterRetry2?.deliveredAt, undefined, 'Must NEVER mark delivered without successful send');
      assert.equal(attemptsCount, 2, 'Must have performed real network attempts');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // Test 11: No recipients configured is failure (fail closed)
  await test('11. Negative: No-recipient / no-delivery returns failure and creates failed delivery audit', async () => {
    const res = await dispatcher.dispatch(
      'tenant_abc',
      'empty.recipients.event',
      { foo: 'bar' },
      {
        email: {
          enabled: true,
          provider: 'sendgrid',
          apiKeyRef: 'sendgrid_secret_ref',
          defaultRecipients: [], // Empty!
        },
      },
      { recipients: [] }
    );

    assert.equal(res.success, false, 'Dispatch must return success: false when no recipients are configured');
    assert.equal(res.deliveries.length, 1);
    assert.equal(res.deliveries[0].status, 'failed');
    assert.match(res.deliveries[0].error || '', /No recipients configured/i);

    // Empty channels config should also fail
    const emptyRes = await dispatcher.dispatch('tenant_abc', 'empty.event', {}, {});
    assert.equal(emptyRes.success, false, 'Dispatch with no enabled channels must return success: false');
  });

  // Test 12: Unsigned outbound webhook is rejected
  await test('12. Negative: Outbound webhook requires secretRef and valid tenant secret for HMAC signing', async () => {
    // Missing secretRef
    const resNoSecret = await dispatcher.dispatch(
      'tenant_abc',
      'webhook.unsigned',
      { data: 123 },
      {
        webhook: {
          enabled: true,
          url: 'https://example.com/webhook',
        },
      }
    );
    assert.equal(resNoSecret.success, false);
    assert.equal(resNoSecret.deliveries[0].status, 'failed');
    assert.match(resNoSecret.deliveries[0].error || '', /requires secretRef for HMAC signing/i);

    // Unresolved secretRef
    const resUnresolved = await dispatcher.dispatch(
      'tenant_abc',
      'webhook.unresolved',
      { data: 123 },
      {
        webhook: {
          enabled: true,
          url: 'https://example.com/webhook',
          secretRef: 'nonexistent_webhook_secret',
        },
      }
    );
    assert.equal(resUnresolved.success, false);
    assert.equal(resUnresolved.deliveries[0].status, 'failed');
    assert.match(resUnresolved.deliveries[0].error || '', /could not be resolved/i);
  });

  // Test 13: retryDelivery strictly scoped by tenantId, environmentId, provider, and deliveryId
  await test('13. Scoped retry: Cross-tenant or mismatched environment delivery cannot be retried', async () => {
    const targetDeliv = insertedDeliveries.find((d) => d.tenantId === 'tenant_abc');
    assert.ok(targetDeliv);

    // Attempting retry with wrong tenantId must return null (not found)
    const mismatchedTenant = await dispatcher.retryDelivery(
      'tenant_xyz',
      'production',
      'resend',
      targetDeliv.deliveryId,
      { email: { enabled: true, apiKeyRef: 'resend_secret_ref' } }
    );
    assert.equal(mismatchedTenant, null, 'Retry query must not match delivery belonging to different tenant');

    // Attempting retry with wrong environmentId must return null
    const mismatchedEnv = await dispatcher.retryDelivery(
      'tenant_abc',
      'staging' as any,
      'resend',
      targetDeliv.deliveryId,
      { email: { enabled: true, apiKeyRef: 'resend_secret_ref' } }
    );
    assert.equal(mismatchedEnv, null, 'Retry query must not match delivery in different environment');

    // Negative: Unscoped retry attempt throws fail-closed error
    await assert.rejects(
      async () => {
        await (dispatcher as any).retryDelivery('', 'production', 'resend', targetDeliv.deliveryId);
      },
      /unscoped retry is forbidden/i,
      'Unscoped retry without tenantId must throw'
    );

    // Negative: Webhook callback with unmatched deliveryId must NOT record deduplication entry
    const initialCallbacksCount = insertedCallbacks.length;
    const unmatchedPayload = JSON.stringify({ deliveryId: 'non_existent_deliv_999', event: 'delivered' });
    const unmatchedHmac = createHmac('sha256', 'mock_secret_val').update(unmatchedPayload).digest('hex');
    const callbackResult = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${unmatchedHmac}` },
      JSON.parse(unmatchedPayload),
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(callbackResult.processed, 0, 'Unmatched delivery must not be processed');
    assert.equal(insertedCallbacks.length, initialCallbacksCount, 'Unmatched delivery must NOT record deduplication callback');
  });

  // ── Test 14: SendGrid ECDSA signature contract validation ─────────────────────
  await test('14. SendGrid ECDSA signature contract verified; generic custom HMAC rejected', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    // Create a delivery record for SendGrid
    const sgDeliveryId = 'deliv_sg_ecdsa_01';
    insertedDeliveries.push({
      deliveryId: sgDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'evt_sg_test',
      channel: 'email',
      provider: 'sendgrid',
      recipient: 'user@example.com',
      routingDecision: { channel: 'email', provider: 'sendgrid', recipient: 'user@example.com', reason: 'test' },
      status: 'retrying',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const callbackPayload = [{ deliveryId: sgDeliveryId, event: 'delivered', id: 'sg_msg_123' }];
    const rawPayload = JSON.stringify(callbackPayload);
    const timestamp = Math.floor(Date.now() / 1000).toString();

    const sign = createSign('SHA256');
    sign.update(`${timestamp}${rawPayload}`);
    const validEcdsaSig = sign.sign(privateKey, 'base64');

    // 14a: Successful ECDSA verification updates status
    const sgResult = await dispatcher.handleEmailWebhookCallback(
      'sendgrid',
      {
        'x-twilio-email-event-webhook-signature': validEcdsaSig,
        'x-twilio-email-event-webhook-timestamp': timestamp,
      },
      callbackPayload,
      {
        publicKey: pubPem,
        tenantId: 'tenant_abc',
        environmentId: 'production',
      }
    );
    assert.equal(sgResult.processed, 1, 'SendGrid ECDSA callback must be processed');
    const updatedSg = insertedDeliveries.find((d) => d.deliveryId === sgDeliveryId);
    assert.equal(updatedSg?.status, 'delivered');

    // 14b: Negative: Generic custom HMAC must be rejected when provider is SendGrid
    const genericHmac = createHmac('sha256', 'mock_secret').update(rawPayload).digest('hex');
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'sendgrid',
          { 'x-journeyax-signature': `sha256=${genericHmac}` },
          callbackPayload,
          {
            publicKey: pubPem,
            tenantId: 'tenant_abc',
            environmentId: 'production',
          }
        );
      },
      /Generic custom HMAC is not sufficient for SendGrid provider; SendGrid ECDSA signature contract is required/i,
      'SendGrid provider must reject generic HMAC'
    );

    // 14c: Negative: Tampered ECDSA signature fails closed
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'sendgrid',
          {
            'x-twilio-email-event-webhook-signature': 'invalid_base64_tampered_sig==',
            'x-twilio-email-event-webhook-timestamp': timestamp,
          },
          callbackPayload,
          {
            publicKey: pubPem,
            tenantId: 'tenant_abc',
            environmentId: 'production',
          }
        );
      },
      /Invalid SendGrid webhook ECDSA signature/i,
      'Tampered ECDSA signature must be rejected'
    );
  });

  // ── Test 15: Replay attack prevention via timestamp expiration ────────────────
  await test('15. Replay attack rejection: expired signature timestamp is rejected', async () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' }).toString();
    const expiredTimestamp = (Math.floor(Date.now() / 1000) - 900).toString(); // 15 mins ago

    const payload = [{ deliveryId: 'deliv_sg_ecdsa_01', event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const sign = createSign('SHA256');
    sign.update(`${expiredTimestamp}${rawPayload}`);
    const sig = sign.sign(privateKey, 'base64');

    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'sendgrid',
          {
            'x-twilio-email-event-webhook-signature': sig,
            'x-twilio-email-event-webhook-timestamp': expiredTimestamp,
          },
          payload,
          {
            publicKey: pubPem,
            tenantId: 'tenant_abc',
            environmentId: 'production',
          }
        );
      },
      /replay detected/i,
      'Expired signature timestamp must be rejected as replay'
    );
  });

  // ── Test 16: Transactional recoverability on partial failure ───────────────────
  await test('16. Transactional recoverability: premature callback insert does not ignore retries forever', async () => {
    const recovDeliveryId = 'deliv_recoverable_01';
    insertedDeliveries.push({
      deliveryId: recovDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'evt_recov_test',
      channel: 'email',
      provider: 'generic',
      recipient: 'recov@example.com',
      routingDecision: { channel: 'email', provider: 'generic', recipient: 'recov@example.com', reason: 'test' },
      status: 'retrying', // Delivery was NEVER updated to delivered
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    // Simulate a prior crash: a callback record was inserted, but delivery update failed
    const staleDedupKey = `generic:tenant_abc:${recovDeliveryId}:delivered`;
    insertedCallbacks.push({
      callbackId: staleDedupKey,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      provider: 'generic',
      deliveryId: recovDeliveryId,
      status: 'delivered',
      processedAt: new Date(Date.now() - 5000),
      rawPayload: {},
    });

    const payload = [{ deliveryId: recovDeliveryId, event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const hmac = createHmac('sha256', 'mock_secret_val').update(rawPayload).digest('hex');

    // Webhook retry arrives: Must NOT be skipped as duplicate; must recover and update delivery
    const retryResult = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${hmac}` },
      payload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );

    assert.equal(retryResult.processed, 1, 'Retry must successfully process despite stale callback record');
    const updatedRecov = insertedDeliveries.find((d) => d.deliveryId === recovDeliveryId);
    assert.equal(updatedRecov?.status, 'delivered', 'Delivery status must be updated on retry');
  });

  // ── Test 17: Concurrent webhook callbacks processed cleanly ───────────────────
  await test('17. Concurrent webhook callbacks execute idempotently without unhandled collisions', async () => {
    const concurrentDeliveryId = 'deliv_concurrent_01';
    insertedDeliveries.push({
      deliveryId: concurrentDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'evt_concurrent_test',
      channel: 'email',
      provider: 'generic',
      recipient: 'concurrent@example.com',
      routingDecision: { channel: 'email', provider: 'generic', recipient: 'concurrent@example.com', reason: 'test' },
      status: 'retrying',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const payload = [{ deliveryId: concurrentDeliveryId, event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const hmac = createHmac('sha256', 'mock_secret_val').update(rawPayload).digest('hex');

    // Run parallel callbacks
    const [resA, resB] = await Promise.all([
      dispatcher.handleEmailWebhookCallback(
        'generic',
        { 'x-webhook-signature': `sha256=${hmac}` },
        payload,
        'mock_secret_val',
        'tenant_abc',
        'production'
      ),
      dispatcher.handleEmailWebhookCallback(
        'generic',
        { 'x-webhook-signature': `sha256=${hmac}` },
        payload,
        'mock_secret_val',
        'tenant_abc',
        'production'
      ),
    ]);

    // One updates delivery, one may deduplicate; combined processed count is 1
    assert.equal(resA.processed + resB.processed, 1, 'Only one concurrent callback should mark processed');
    const finalDeliv = insertedDeliveries.find((d) => d.deliveryId === concurrentDeliveryId);
    assert.equal(finalDeliv?.status, 'delivered');
  });

  // ── Test 18: Mandatory trusted inputs fail-closed (no silent production fallback) ─
  await test('18. Mandatory trusted inputs: missing tenantId or environmentId fails closed', async () => {
    const payload = [{ deliveryId: 'deliv_1', event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const hmac = createHmac('sha256', 'mock_secret_val').update(rawPayload).digest('hex');
    const headers = { 'x-webhook-signature': `sha256=${hmac}` };

    // Missing tenantId
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback('generic', headers, payload, {
          secret: 'mock_secret_val',
          tenantId: '',
          environmentId: 'production',
        });
      },
      /Trusted tenantId is mandatory/i,
      'Empty tenantId must throw fail-closed'
    );

    // Missing environmentId (no silent default to production)
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback('generic', headers, payload, {
          secret: 'mock_secret_val',
          tenantId: 'tenant_abc',
          environmentId: '' as any,
        });
      },
      /Trusted environmentId is mandatory/i,
      'Empty environmentId must throw fail-closed without defaulting to production'
    );
  });

  // ── Test 19: Wrong tenant, environment, and provider isolation ─────────────────
  await test('19. Boundary isolation: wrong tenant, environment, or provider matches zero deliveries', async () => {
    const isoDeliveryId = 'deliv_iso_01';
    insertedDeliveries.push({
      deliveryId: isoDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'evt_iso_test',
      channel: 'email',
      provider: 'sendgrid',
      recipient: 'iso@example.com',
      routingDecision: { channel: 'email', provider: 'sendgrid', recipient: 'iso@example.com', reason: 'test' },
      status: 'retrying',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const payload = [{ deliveryId: isoDeliveryId, event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const hmac = createHmac('sha256', 'mock_secret_val').update(rawPayload).digest('hex');
    const headers = { 'x-webhook-signature': `sha256=${hmac}` };

    // 19a. Wrong tenant
    const wrongTenantRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      headers,
      payload,
      'mock_secret_val',
      'tenant_other',
      'production'
    );
    assert.equal(wrongTenantRes.processed, 0);
    assert.ok(wrongTenantRes.errors[0].includes('No matching delivery record'));

    // 19b. Wrong environment
    const wrongEnvRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      headers,
      payload,
      'mock_secret_val',
      'tenant_abc',
      'staging'
    );
    assert.equal(wrongEnvRes.processed, 0);
    assert.ok(wrongEnvRes.errors[0].includes('No matching delivery record'));

    // 19c. Wrong provider
    const wrongProviderRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      headers,
      payload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(wrongProviderRes.processed, 0, 'Generic provider cannot update sendgrid delivery');
    assert.ok(wrongProviderRes.errors[0].includes('No matching delivery record'));
  });

  // Test 20: Cross-environment secret rejection
  await test('20. Negative Cross-Environment: Tenant ABC staging secret cannot be resolved in production', async () => {
    // staging_only_secret is defined for staging, not production
    const prodSecret = await dispatcher.resolveSecret('tenant_abc', 'production', 'staging_only_secret');
    assert.equal(prodSecret, null, 'Staging secret must not be resolved in production environment');

    const stagingSecret = await dispatcher.resolveSecret('tenant_abc', 'staging', 'staging_only_secret');
    assert.equal(stagingSecret, 'staging_secret_val', 'Staging secret must be resolved in staging environment');
  });

  // Test 21: Missing Svix headers reject for Resend provider
  await test('21. Negative Missing Svix Headers: Resend provider requires svix-id, svix-timestamp, svix-signature', async () => {
    const payload = [{ deliveryId: 'deliv_svix_01', event: 'delivered' }];
    const validTimestamp = String(Math.floor(Date.now() / 1000));

    // Missing svix-id
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'resend',
          { 'svix-timestamp': validTimestamp, 'svix-signature': 'v1,some_sig' },
          payload,
          'wh_mock_secret_key',
          'tenant_abc',
          'production'
        );
      },
      /requires svix-id header/i
    );

    // Missing svix-timestamp
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'resend',
          { 'svix-id': 'msg_01', 'svix-signature': 'v1,some_sig' },
          payload,
          'wh_mock_secret_key',
          'tenant_abc',
          'production'
        );
      },
      /requires svix-timestamp header/i
    );

    // Missing svix-signature
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'resend',
          { 'svix-id': 'msg_01', 'svix-timestamp': validTimestamp },
          payload,
          'wh_mock_secret_key',
          'tenant_abc',
          'production'
        );
      },
      /requires svix-signature header/i
    );

    // Expired svix-timestamp (> 300 seconds)
    const expiredTimestamp = String(Math.floor(Date.now() / 1000) - 305);
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'resend',
          { 'svix-id': 'msg_01', 'svix-timestamp': expiredTimestamp, 'svix-signature': 'v1,some_sig' },
          payload,
          'wh_mock_secret_key',
          'tenant_abc',
          'production'
        );
      },
      /timestamp expired or invalid/i
    );
  });

  // Test 22: Official Svix signature verification with whsec_ base64 secret decoding
  await test('22. Official Svix signature: base64-decoded whsec_ secret and v1,<base64> signature verification', async () => {
    const deliveryId = 'deliv_svix_official_01';
    insertedDeliveries.push({
      deliveryId,
      tenantId: 'tenant_svix',
      environmentId: 'production',
      provider: 'resend',
      recipient: 'user@svix.com',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const rawSecret = 'whsec_54B3p6e5a6r2h3v5a4s5b6c7d8e9f0a1b2c3d4e5f6g=';
    const payload = [{ deliveryId, event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const svixId = 'msg_svix_official';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const toSign = `${svixId}.${svixTimestamp}.${rawPayload}`;

    // Official Svix signing: decode base64 after whsec_ prefix
    const secretBytes = Buffer.from(rawSecret.slice(6), 'base64');
    const validSig = createHmac('sha256', secretBytes).update(toSign).digest('base64');

    // Valid official Svix signature succeeds
    const successRes = await dispatcher.handleEmailWebhookCallback(
      'resend',
      {
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${validSig}`,
      },
      payload,
      rawSecret,
      'tenant_svix',
      'production'
    );
    assert.equal(successRes.processed, 1);
    const deliv = insertedDeliveries.find((d) => d.deliveryId === deliveryId);
    assert.equal(deliv?.status, 'delivered');

    // Forged signature fails
    await assert.rejects(
      async () => {
        await dispatcher.handleEmailWebhookCallback(
          'resend',
          {
            'svix-id': svixId,
            'svix-timestamp': svixTimestamp,
            'svix-signature': 'v1,forgedBadSignatureBase64==',
          },
          payload,
          rawSecret,
          'tenant_svix',
          'production'
        );
      },
      /Invalid webhook callback signature/i
    );
  });

  // Test 23: Metadata preservation via dotted MongoDB updates
  await test('23. Metadata preservation: webhook callback preserves durable fields on delivery record', async () => {
    const deliveryId = 'deliv_meta_preserve_01';
    insertedDeliveries.push({
      deliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      provider: 'generic',
      recipient: 'meta_user@example.com',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      metadata: {
        orderId: 'ord_preserve_999',
        recipientName: 'Alice Smith',
        customField: { nested: true, count: 42 },
      },
      createdAt: new Date(),
    });

    const payload = [{ deliveryId, event: 'delivered' }];
    const rawPayload = JSON.stringify(payload);
    const hmac = createHmac('sha256', 'mock_secret_val').update(rawPayload).digest('hex');

    const res = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${hmac}` },
      payload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(res.processed, 1);

    const updated = insertedDeliveries.find((d) => d.deliveryId === deliveryId);
    assert.ok(updated);
    assert.equal(updated.status, 'delivered');
    // Pre-existing durable metadata fields MUST still exist and not be overwritten!
    assert.equal(updated.metadata.orderId, 'ord_preserve_999');
    assert.equal(updated.metadata.recipientName, 'Alice Smith');
    assert.equal(updated.metadata.customField.nested, true);
    assert.equal(updated.metadata.customField.count, 42);
    // Webhook callback fields are merged in
    assert.equal(updated.metadata.callbackEvent, 'delivered');
    assert.ok(updated.metadata.callbackTimestamp instanceof Date);
  });

  // Test 24: Out-of-order webhook callback monotonic terminal-state rules
  await test('24. Out-of-order callback: status cannot regress from delivered or terminal bounced state', async () => {
    const deliveryId = 'deliv_order_monotonic_01';
    const now = Date.now();
    insertedDeliveries.push({
      deliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      provider: 'generic',
      recipient: 'monotonic@example.com',
      status: 'delivered', // Already reached delivered!
      attempts: 1,
      maxAttempts: 3,
      metadata: {
        callbackTimestamp: new Date(now),
        callbackEvent: 'delivered',
      },
      createdAt: new Date(now - 10000),
    });

    // 24a. Out-of-order delayed 'sent' / 'processed' event arrives (lower rank)
    const delayedPayload = [{ deliveryId, event: 'sent', timestamp: Math.floor((now - 5000) / 1000) }];
    const delayedHmac = createHmac('sha256', 'mock_secret_val').update(JSON.stringify(delayedPayload)).digest('hex');

    const delayedRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${delayedHmac}` },
      delayedPayload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(delayedRes.processed, 1);
    const delivAfterDelayed = insertedDeliveries.find((d) => d.deliveryId === deliveryId);
    assert.equal(delivAfterDelayed?.status, 'delivered', 'Out-of-order sent event must NOT regress delivered status');

    // 24b. Delivery reaches terminal bounced failure state
    delivAfterDelayed!.status = 'bounced';
    delivAfterDelayed!.metadata.callbackTimestamp = new Date(now + 1000);
    delivAfterDelayed!.metadata.callbackEvent = 'bounced';

    // Out-of-order 'delivered' arrives after bounce: must not regress bounced
    const lateDelivPayload = [{ deliveryId, event: 'delivered', timestamp: Math.floor(now / 1000) }];
    const lateHmac = createHmac('sha256', 'mock_secret_val').update(JSON.stringify(lateDelivPayload)).digest('hex');

    const lateRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${lateHmac}` },
      lateDelivPayload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(lateRes.processed, 1);
    const delivAfterBounce = insertedDeliveries.find((d) => d.deliveryId === deliveryId);
    assert.equal(delivAfterBounce?.status, 'bounced', 'Terminal bounced state must not regress on late delivered event');
  });

  // Test 25: Negative: Unsupported/unknown callback event type is rejected without changing delivery state
  await test('25. Negative: Unsupported/unknown callback event status is rejected and delivery state remains unchanged', async () => {
    const deliveryId = 'deliv_unknown_type_test';
    insertedDeliveries.push({
      deliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'test.unknown_status',
      channel: 'email',
      provider: 'generic',
      recipient: 'unknown@example.com',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const unknownPayload = [{ deliveryId, event: 'billing.payment_succeeded' }];
    const hmac = createHmac('sha256', 'mock_secret_val').update(JSON.stringify(unknownPayload)).digest('hex');

    const res = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${hmac}` },
      unknownPayload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );

    assert.equal(res.processed, 0, 'Unsupported event type must not be marked processed');
    assert.ok(
      res.errors.some((e) => e.includes("Unsupported or unrecognized callback event status 'billing.payment_succeeded'")),
      'Must record error indicating unsupported event status'
    );
    const deliv = insertedDeliveries.find((d) => d.deliveryId === deliveryId);
    assert.equal(deliv?.status, 'pending', 'Delivery status must remain unchanged for unsupported event type');
  });

  // Test 26: Cross-environment callback dedup: equal delivery IDs in different environments cannot collide
  await test('26. Cross-environment callback dedup: equal delivery IDs in different environments do not collide', async () => {
    const sharedDeliveryId = 'deliv_shared_cross_env';

    // Insert delivery in staging
    insertedDeliveries.push({
      deliveryId: sharedDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'staging',
      eventId: 'test.staging_evt',
      channel: 'email',
      provider: 'generic',
      recipient: 'staging_user@example.com',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    // Insert delivery with SAME deliveryId in production
    insertedDeliveries.push({
      deliveryId: sharedDeliveryId,
      tenantId: 'tenant_abc',
      environmentId: 'production',
      eventId: 'test.prod_evt',
      channel: 'email',
      provider: 'generic',
      recipient: 'prod_user@example.com',
      status: 'pending',
      attempts: 1,
      maxAttempts: 3,
      createdAt: new Date(),
    });

    const stagingPayload = [{ deliveryId: sharedDeliveryId, event: 'delivered', id: 'evt_staging_001' }];
    const stagingHmac = createHmac('sha256', 'mock_secret_val').update(JSON.stringify(stagingPayload)).digest('hex');

    const stagingRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${stagingHmac}` },
      stagingPayload,
      'mock_secret_val',
      'tenant_abc',
      'staging'
    );
    assert.equal(stagingRes.processed, 1, 'Staging delivery callback must succeed');

    const prodPayload = [{ deliveryId: sharedDeliveryId, event: 'delivered', id: 'evt_prod_001' }];
    const prodHmac = createHmac('sha256', 'mock_secret_val').update(JSON.stringify(prodPayload)).digest('hex');

    const prodRes = await dispatcher.handleEmailWebhookCallback(
      'generic',
      { 'x-webhook-signature': `sha256=${prodHmac}` },
      prodPayload,
      'mock_secret_val',
      'tenant_abc',
      'production'
    );
    assert.equal(prodRes.processed, 1, 'Production delivery callback must succeed and NOT collide with staging dedup');

    const stagingDeliv = insertedDeliveries.find((d) => d.deliveryId === sharedDeliveryId && d.environmentId === 'staging');
    const prodDeliv = insertedDeliveries.find((d) => d.deliveryId === sharedDeliveryId && d.environmentId === 'production');

    assert.equal(stagingDeliv?.status, 'delivered', 'Staging delivery must be delivered');
    assert.equal(prodDeliv?.status, 'delivered', 'Production delivery must be delivered');
  });

  console.log(`\nNotification Tests Complete: ${passed} passed, ${failed} failed.\n`);
  if (failed > 0) process.exit(1);
}

runNotificationTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
