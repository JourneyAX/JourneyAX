import '../../../packages/jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateConversationId } from '../src/auth/conversation-scope';
import type { AuthContext } from '../src/auth/auth.guard';

const alice: AuthContext = { tenantId: 'tenant-a', environmentId: 'test', principalId: 'alice', principalRole: 'customer', principalGroups: [], isInternal: false };
test('conversation, cart and transcript namespaces are bound to the verified person and environment', () => {
  const id = privateConversationId('client-chat', alice);
  assert.equal(privateConversationId(id, alice), id, 'a returned id continues the same conversation');
  for (const other of [{ ...alice, principalId: 'bob' }, { ...alice, tenantId: 'tenant-b' }, { ...alice, environmentId: 'staging' as const }]) {
    assert.notEqual(privateConversationId('client-chat', other), id);
    assert.notEqual(privateConversationId(id, other), id, 'knowing another conversation id does not grant access');
  }
});
test('a shared anonymous principal cannot access persisted private memory', () => {
  for (const principalId of ['', 'anonymous', 'guest', 'guest@anonymous']) assert.throws(() => privateConversationId('old-timestamp-chat', { ...alice, principalId }));
});
