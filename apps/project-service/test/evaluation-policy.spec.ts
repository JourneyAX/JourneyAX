import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { ProjectService } from '../src/project.service';

test('mandatory evaluation policy survives the normal draft save; a caller cannot supply a passing result', async () => {
  const db = new MemoryDb(); const service = new ProjectService(); service.setDbForTesting(db as any);
  await db.collection('tenant_configs').insertOne({ projectId: 'merchant-a' });
  assert.equal((await service.updateProject('merchant-a', { evaluationGate: { required: true } })).success, true);
  assert.deepEqual((await db.collection('tenant_configs').findOne({ projectId: 'merchant-a' })).evaluationGate, { required: true });
  assert.equal((await service.updateProject('merchant-a', { evaluationGate: { required: true, passed: true } } as any)).success, false);
  assert.equal((await service.updateProject('merchant-a', { evaluationGate: { required: 'yes' } } as any)).success, false);
});
