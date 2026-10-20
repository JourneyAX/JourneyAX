import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { buildPlaceMakersStack, TENANT, ENVIRONMENT } from './helpers/placemakers-stack';

const suite = createSuite('turn-timing: structured timing, latencies and token counts');

async function main() {
  await suite.test('every turn records structured timing and token metrics on trace', async () => {
    const stack = await buildPlaceMakersStack();
    const calls: string[] = [];
    const service = stack.serviceFor({ servePacks: true, calls });

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: any[]) => {
      logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
      originalLog.apply(console, args);
    };

    let result: any;
    try {
      result = await service.executeTurn({
        tenantId: TENANT,
        environmentId: ENVIRONMENT,
        workspaceId: 'ws-timing-test',
        turnId: 'turn-1',
        message: 'Show me decking screws',
      });
    } finally {
      console.log = originalLog;
    }

    assert.ok(result.trace, 'trace exists');
    assert.ok(result.trace.timing, 'timing object exists on trace');

    const timing = result.trace.timing;
    assert.equal(typeof timing.totalMs, 'number');
    assert.ok(timing.totalMs >= 0);
    assert.equal(typeof timing.interpretMs, 'number');
    assert.equal(typeof timing.responseMs, 'number');
    assert.equal(typeof timing.retrievalMs, 'number');
    assert.equal(typeof timing.phraseMs, 'number');
    assert.equal(typeof timing.modelCalls, 'number');
    assert.ok(timing.modelCalls >= 1, 'at least 1 model call occurred');

    assert.ok(timing.tokens, 'token usage object exists');
    assert.equal(typeof timing.tokens.prompt, 'number');
    assert.equal(typeof timing.tokens.completion, 'number');
    assert.equal(typeof timing.tokens.total, 'number');
    assert.ok(timing.tokens.total > 0, 'token count accumulated from gateway');

    // Verify structured JSON log was emitted
    const timingLog = logs.find((l) => l.includes('"event":"turn.timing"'));
    assert.ok(timingLog, 'emitted structured turn.timing JSON log');
    const parsed = JSON.parse(timingLog!);
    assert.equal(parsed.event, 'turn.timing');
    assert.equal(parsed.tenantId, TENANT);
    assert.equal(parsed.turnId, 'turn-1');
    assert.equal(parsed.tokens.total, timing.tokens.total);
    assert.ok(typeof parsed.timeToFirstEventMs === 'number' && parsed.timeToFirstEventMs >= 0, 'timeToFirstEventMs is measured after session');
  });

  await suite.test('Task B3: phrasing is merged into response step with zero extra phrase calls', async () => {
    const stack = await buildPlaceMakersStack();
    const calls: string[] = [];
    const service = stack.serviceFor({ servePacks: true, calls });

    const result = await service.executeTurn({
      tenantId: TENANT,
      environmentId: ENVIRONMENT,
      workspaceId: 'ws-phrase-check',
      turnId: 'turn-1',
      message: 'Show me decking screws',
    });

    assert.ok(typeof result.trace?.timing?.phraseMs === 'number' && result.trace?.timing?.phraseMs >= 0, 'phraseMs is measured locally');
    assert.equal(calls.includes('phraseMessage'), false, 'no separate phraseMessage call was dispatched');
  });
}

main().then(() => { suite.finish(); }).catch((error) => { console.error(error); process.exitCode = 1; });
