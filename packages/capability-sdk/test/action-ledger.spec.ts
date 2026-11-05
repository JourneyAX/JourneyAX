import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { CapabilityDispatcher, MemoryActionLedger } from '../src';

const tool: any = { toolId: 'support.create', sideEffect: 'write', risk: 'low' };
const binding: any = { executor: { type: 'native_capability', nativeHandler: 'write' } };
const context: any = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'staff-1', workspaceId: 'case-1', idempotencyKey: 'approved-1', correlationId: 'trace-1' };
const request: any = { toolId: tool.toolId, input: { subject: 'help' }, policyState: 'allow', userConfirmationConfirmed: true };

test('a write without action storage fails before touching a system', async () => {
  let calls = 0;
  const dispatcher = new CapabilityDispatcher(); dispatcher.registerNativeHandler('write', { execute: async () => { calls++; } });
  assert.equal((await dispatcher.dispatch(tool, binding, request, context)).status, 'failure'); assert.equal(calls, 0);
});
test('concurrent workers execute once and later replay the stored receipt', async () => {
  let calls = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ledger = new MemoryActionLedger();
  const a = new CapabilityDispatcher({ actionLedger: ledger }); const b = new CapabilityDispatcher({ actionLedger: ledger });
  const handler = { execute: async () => { calls++; await gate; return { ticketId: 'real-receipt' }; } };
  a.registerNativeHandler('write', handler); b.registerNativeHandler('write', handler);
  const first = a.dispatch(tool, binding, request, context);
  const second = await b.dispatch(tool, binding, request, context);
  assert.equal(second.status, 'failure'); release();
  const done = await first; assert.equal(done.status, 'success');
  const replay = await b.dispatch(tool, binding, request, context);
  assert.equal(replay.status, 'success'); assert.deepEqual(replay.output, { ticketId: 'real-receipt' }); assert.equal(calls, 1);
});
test('an uncertain vendor outcome is not automatically repeated', async () => {
  let calls = 0;
  const dispatcher = new CapabilityDispatcher({ actionLedger: new MemoryActionLedger() });
  dispatcher.registerNativeHandler('write', { execute: async () => { calls++; throw new Error('connection lost after write'); } });
  assert.equal((await dispatcher.dispatch(tool, binding, request, context)).status, 'failure');
  assert.equal((await dispatcher.dispatch(tool, binding, request, context)).status, 'failure'); assert.equal(calls, 1);
});
test('tenant, environment and person use separate action scopes; denial never claims an action', async () => {
  let calls = 0;
  const dispatcher = new CapabilityDispatcher({ actionLedger: new MemoryActionLedger() }); dispatcher.registerNativeHandler('write', { execute: async () => ({ count: ++calls }) });
  assert.equal((await dispatcher.dispatch(tool, binding, { ...request, policyState: 'blocked' }, context)).status, 'denied');
  for (const scope of [context, { ...context, tenantId: 'tenant-b' }, { ...context, environmentId: 'staging' }, { ...context, principalId: 'staff-2' }]) assert.equal((await dispatcher.dispatch(tool, binding, request, scope)).status, 'success');
  assert.equal(calls, 4);
});
test('a fixed approved action cannot be replayed with changed arguments', async () => {
  let calls = 0;
  const dispatcher = new CapabilityDispatcher({ actionLedger: new MemoryActionLedger() }); dispatcher.registerNativeHandler('write', { execute: async () => ({ count: ++calls }) });
  const fixed = { ...context, actionId: 'approval-slot-1' };
  assert.equal((await dispatcher.dispatch(tool, binding, request, fixed)).status, 'success');
  assert.equal((await dispatcher.dispatch(tool, binding, { ...request, input: { subject: 'changed' } }, fixed)).status, 'failure');
  assert.equal(calls, 1);
});
