import assert from 'node:assert/strict';
import { HttpException, HttpStatus, ServiceUnavailableException, BadRequestException } from '@nestjs/common';
import { JourneyAXController } from '../src/agent.controller';
import { AgentService } from '../src/agent.service';

/**
 * Controller-Level HTTP Error Semantics Test Suite
 *
 * Proves:
 * 1. Activation failures throw/return 503 and are NEVER converted into HTTP 200 assistant messages.
 * 2. Validation failures throw/return 4xx and preserve their exact client error status.
 * 3. Both buffered (/chat) and streaming (/chat/stream) endpoints correctly reflect HTTP error semantics.
 */
async function runControllerErrorSemanticsSuite() {
  console.log('🧪 Running Agent Controller HTTP Error Semantics Test Suite...\n');

  // ── Test 1: Missing tenantId in buffered /chat throws 400 ──
  console.log('1. Testing missing tenantId in buffered /chat...');
  {
    const mockAgentService = {} as AgentService;
    const controller = new JourneyAXController(
      mockAgentService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await assert.rejects(
      async () => {
        await controller.chat('', '', { message: 'hello', tenantId: '' });
      },
      (err: any) => {
        assert.ok(err instanceof HttpException, 'Must be an HttpException');
        assert.equal(err.getStatus(), HttpStatus.BAD_REQUEST, 'Must have HTTP 400 status');
        return true;
      }
    );
    console.log('   ✅ PASS: Missing tenantId throws HttpStatus.BAD_REQUEST (400)');
  }

  // ── Test 2: Activation failure in buffered /chat propagates 503 and never returns 200 assistant message ──
  console.log('2. Testing activation failure in buffered /chat propagates 503...');
  {
    const mockAgentService = {
      processChat: async () => {
        throw new ServiceUnavailableException('Release activation blocked: checksum mismatch');
      },
    } as unknown as AgentService;

    const controller = new JourneyAXController(
      mockAgentService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await assert.rejects(
      async () => {
        await controller.chat('test-tenant', 'test-tenant', { message: 'hello' });
      },
      (err: any) => {
        assert.ok(err instanceof HttpException, 'Must be an HttpException');
        assert.equal(err.getStatus(), HttpStatus.SERVICE_UNAVAILABLE, 'Must have HTTP 503 status');
        assert.ok(!err.message.includes('role'), 'Must not be converted into assistant message object');
        return true;
      }
    );
    console.log('   ✅ PASS: Activation failure throws HttpStatus.SERVICE_UNAVAILABLE (503)');
  }

  // ── Test 3: Validation failure in buffered /chat preserves 4xx status ──
  console.log('3. Testing validation failure in buffered /chat preserves 4xx...');
  {
    const mockAgentService = {
      processChat: async () => {
        throw new BadRequestException('Validation failed: missing required facts');
      },
    } as unknown as AgentService;

    const controller = new JourneyAXController(
      mockAgentService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    await assert.rejects(
      async () => {
        await controller.chat('test-tenant', 'test-tenant', { message: 'hello' });
      },
      (err: any) => {
        assert.ok(err instanceof HttpException, 'Must be an HttpException');
        assert.equal(err.getStatus(), HttpStatus.BAD_REQUEST, 'Must preserve HTTP 400 status');
        return true;
      }
    );
    console.log('   ✅ PASS: Validation failure preserves 4xx status');
  }

  // ── Test 4: Missing tenantId in streaming /chat/stream returns 400 ──
  console.log('4. Testing missing tenantId in /chat/stream...');
  {
    const mockAgentService = {} as AgentService;
    const controller = new JourneyAXController(
      mockAgentService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    let recordedStatus = 0;
    let recordedJson: any = null;
    const res = {
      status(code: number) {
        recordedStatus = code;
        return this;
      },
      json(body: any) {
        recordedJson = body;
        return this;
      },
    } as any;

    await controller.chatStream('', '', { message: 'hello' }, res);
    assert.equal(recordedStatus, 400, 'Must return HTTP 400 for missing tenant');
    assert.equal(recordedJson?.error, 'Bad Request');
    console.log('   ✅ PASS: /chat/stream returns 400 on missing tenantId');
  }

  // ── Test 5: Activation failure in streaming /chat/stream returns 503 before headers flush ──
  console.log('5. Testing activation failure in /chat/stream returns 503...');
  {
    const mockAgentService = {
      processChatStream: async () => {
        throw new ServiceUnavailableException('Cutover repository failure: 503 Service Unavailable');
      },
    } as unknown as AgentService;

    const controller = new JourneyAXController(
      mockAgentService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    let recordedStatus = 0;
    let recordedJson: any = null;
    let headersSent = false;
    const headers: Record<string, string> = {};

    const res = {
      setHeader(name: string, val: string) {
        headers[name] = val;
      },
      flushHeaders() {
        headersSent = true;
      },
      status(code: number) {
        recordedStatus = code;
        return this;
      },
      json(body: any) {
        recordedJson = body;
        return this;
      },
      end() {},
      get headersSent() {
        return headersSent;
      },
    } as any;

    await controller.chatStream('test-tenant', 'test-tenant', { message: 'hello' }, res);
    assert.equal(recordedStatus, 503, 'Must return HTTP 503 on activation failure');
    assert.ok(recordedJson?.message?.includes('Cutover repository failure'));
    assert.equal(headers['Content-Type'], undefined, 'Must not flush SSE headers on pre-flight activation error');
    console.log('   ✅ PASS: Pre-stream activation failure in /chat/stream returns 503 without SSE header leakage');
  }

  console.log('\n🎉 ALL CONTROLLER HTTP ERROR SEMANTICS VERIFIED!\n');
}

runControllerErrorSemanticsSuite().catch((err) => {
  console.error('❌ Controller error semantics test failed:', err);
  process.exit(1);
});
