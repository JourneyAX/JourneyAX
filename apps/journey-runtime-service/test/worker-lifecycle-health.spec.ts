import assert from 'node:assert/strict';
import { OutboxRepository } from '../src/kernel/outbox.repository';
import { OutboxWorker } from '../src/kernel/outbox.worker';
import { OutboxWorkerService } from '../src/kernel/outbox-worker.service';
import { HealthController } from '../src/health.controller';

async function runWorkerLifecycleHealthTests() {
  console.log('--- Starting Worker Lifecycle, Crash Recovery, and Truthful Health Tests ---');
  let passed = 0;
  let failed = 0;

  async function test(name: string, fn: () => Promise<void>) {
    try {
      await fn();
      console.log(`  ✓ ${name}`);
      passed++;
    } catch (err: any) {
      console.error(`  ✗ ${name}`);
      console.error(`    ${err.stack || err.message}`);
      failed++;
    }
  }

  // Section 1: Truthful Health Reporting
  await test('1. HealthController never claims active when OutboxWorker is unconfigured or missing MONGODB_URI', async () => {
    const originalUri = process.env.MONGODB_URI;
    delete process.env.MONGODB_URI;

    try {
      const service = new OutboxWorkerService();
      await service.onModuleInit();

      assert.equal(service.getWorker(), null, 'Worker should not be created without durable storage config');
      assert.match(
        service.getConfigurationFailure() || '',
        /Missing required MONGODB_URI/i,
        'Should record configuration failure message'
      );

      const controller = new HealthController(service);
      const health = await controller.workerHealth();

      assert.equal(health.worker, 'inactive', 'Health report must NEVER claim active without a worker');
      assert.equal(health.state, 'failed_config', 'State should be failed_config');
      assert.equal(health.status, 'unhealthy');
      assert.match(health.configurationFailure || '', /Missing required MONGODB_URI/i);
      assert.equal(health.lastSuccessfulPoll, null);
      assert.equal(health.leaseStatus.activeLeases, 0);
    } finally {
      if (originalUri !== undefined) {
        process.env.MONGODB_URI = originalUri;
      }
    }
  });

  await test('2. HealthController reports unconfigured when OutboxWorkerService is missing entirely', async () => {
    const controller = new HealthController(undefined);
    const health = await controller.workerHealth();

    assert.equal(health.worker, 'inactive');
    assert.equal(health.state, 'unconfigured');
    assert.equal(health.status, 'unhealthy');
    assert.match(health.configurationFailure || '', /not registered/i);
  });

  // Section 2: Lifecycle Management
  await test('3. Lifecycle management: Worker starts, polls, and stops gracefully', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();

    let dispatchedCount = 0;
    const worker = service.startWithRepository(
      repo,
      async (evt) => {
        dispatchedCount++;
      },
      {
        workerId: 'test-lifecycle-worker',
        pollIntervalMs: 50,
        leaseDurationMs: 1000,
        batchSize: 5,
      }
    );

    assert.equal(service.getWorker(), worker);
    const initialHealth = await service.getHealthInfo();
    assert.equal(initialHealth.worker, 'active');
    assert.equal(initialHealth.state, 'running');
    assert.equal(initialHealth.status, 'ok');

    // Enqueue an event
    await repo.enqueueEvent(
      'tenant-test-1',
      'test',
      'order.created',
      { orderId: 'ord-123' }
    );

    // Wait for at least one poll
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert(dispatchedCount >= 1, `Expected at least 1 dispatch, got ${dispatchedCount}`);
    const activeHealth = await service.getHealthInfo();
    assert.equal(activeHealth.worker, 'active');
    assert(activeHealth.lastSuccessfulPoll !== null, 'lastSuccessfulPoll must be recorded');
    assert.equal(activeHealth.metrics.published, 1);

    // Stop gracefully
    await service.onModuleDestroy();
    assert.equal(service.getWorker(), null);

    const postDestroyHealth = await service.getHealthInfo();
    assert.equal(postDestroyHealth.worker, 'inactive');
    assert.equal(postDestroyHealth.state, 'unconfigured');
  });

  // Section 3: Crash Recovery & Expired Lease Reclamation
  await test('4. Crash Recovery: Recovers and processes events abandoned by crashed worker with expired lease', async () => {
    const repo = new OutboxRepository();

    // 1. Enqueue event
    const eventId = await repo.enqueueEvent(
      'tenant-crash-test',
      'test',
      'invoice.generated',
      { invoiceId: 'inv-999' }
    );

    // 2. Simulate worker-crashed claiming the event, then dying while lease expires
    const events = repo.getEvents();
    const targetEvent = events.find((e) => e.eventId === eventId);
    assert(targetEvent, 'Target event must exist in queue');

    targetEvent.status = 'leased';
    targetEvent.leasedBy = 'worker-crashed-dead-pid';
    // Expire lease 10 seconds in the past
    targetEvent.leaseExpiresAt = new Date(Date.now() - 10000);

    // Also simulate an active unexpired lease by a healthy worker
    const aliveEventId = await repo.enqueueEvent(
      'tenant-crash-test',
      'test',
      'payment.settled',
      { paymentId: 'pay-111' }
    );
    const aliveEvent = repo.getEvents().find((e) => e.eventId === aliveEventId);
    assert(aliveEvent, 'Alive event must exist');
    aliveEvent.status = 'leased';
    aliveEvent.leasedBy = 'worker-other-alive';
    aliveEvent.leaseExpiresAt = new Date(Date.now() + 60000); // 1 minute in the future

    // 3. New surviving worker starts and processes batch
    let processedEventIds: string[] = [];
    const newWorker = new OutboxWorker(
      repo,
      {
        dispatcher: async (evt) => {
          processedEventIds.push(evt.eventId);
        },
        workerId: 'worker-recovery-hero',
        leaseDurationMs: 5000,
        batchSize: 10,
      }
    );

    const result = await newWorker.processNextBatch();

    // The crashed event should have been reclaimed and processed!
    assert.equal(result.processed, 1, 'Should reclaim exactly 1 expired lease');
    assert.equal(result.succeeded, 1);
    assert.deepEqual(processedEventIds, [eventId], 'Should have processed the abandoned event');

    // Verify status in repository
    assert.equal(targetEvent.status, 'published');
    assert.equal(targetEvent.leasedBy, undefined);

    // Verify that the active, unexpired lease was untouched
    assert.equal(aliveEvent.status, 'leased');
    assert.equal(aliveEvent.leasedBy, 'worker-other-alive');
  });

  // Section 4: Dead-letter threshold & Truthful Health Metrics
  await test('5. Dead-letter progression and degraded health status reporting', async () => {
    const repo = new OutboxRepository();
    const service = new OutboxWorkerService();

    let failAttempts = 0;
    const worker = service.startWithRepository(
      repo,
      async (_evt) => {
        failAttempts++;
        throw new Error('Downstream network timeout');
      },
      {
        workerId: 'worker-flaky-dispatcher',
        maxAttempts: 3,
        backoffBaseMs: 10,
      }
    );

    const eventId = await repo.enqueueEvent(
      'tenant-fail-test',
      'test',
      'webhook.dispatch',
      { hookUrl: 'https://example.com/fail' }
    );

    // Run batch 1 (attempt 1 -> retry_scheduled)
    await worker.processNextBatch();
    const event = repo.getEvents().find((e) => e.eventId === eventId)!;
    assert.equal(event.status, 'pending');
    assert.equal(event.attempts, 1);

    // Fast-forward nextAttemptAt
    event.nextAttemptAt = new Date(Date.now() - 100);

    // Run batch 2 (attempt 2 -> retry_scheduled)
    await worker.processNextBatch();
    assert.equal(event.attempts, 2);

    // Fast-forward nextAttemptAt
    event.nextAttemptAt = new Date(Date.now() - 100);

    // Run batch 3 (attempt 3 -> maxAttempts -> dead_letter)
    await worker.processNextBatch();
    assert.equal(event.attempts, 3);
    assert.equal(event.status, 'dead_letter');
    assert.match(event.error || '', /Downstream network timeout/);

    const health = await service.getHealthInfo();
    assert.equal(health.worker, 'active');
    assert.equal(health.metrics.deadLetter, 1);
    assert.equal(health.status, 'ok', 'Status is ok with <= 50 dead letters');

    // Simulate dead letter threshold exceeding 50
    for (let i = 0; i < 55; i++) {
      const eid = await repo.enqueueEvent(
        'tenant-fail-test',
        'test',
        'fake.deadletter',
        {}
      );
      await repo.recordFailure(eid, 'Simulated bulk failure', 1, 0);
    }

    const degradedHealth = await service.getHealthInfo();
    assert.equal(degradedHealth.metrics.deadLetter, 56);
    assert.equal(degradedHealth.status, 'degraded', 'Health must report degraded when deadLetter > 50');

    service.stopWorker();
  });

  console.log(`\n==================================================`);
  console.log(`Worker Lifecycle & Health Test Summary: ${passed} passed, ${failed} failed`);
  console.log(`==================================================\n`);

  if (failed > 0) {
    process.exit(1);
  }
}

runWorkerLifecycleHealthTests().catch((e) => {
  console.error('Unhandled test failure:', e);
  process.exit(1);
});
