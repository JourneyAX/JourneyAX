import assert from 'node:assert/strict';
import test from 'node:test';
import { orderSurfaceFor } from '../orderSurface';

test('customer receipt links stay owner-scoped; staff references use only a declared permitted operational desk', () => {
  const desks = [{ deskId: 'a-tenant-chosen-name', title: 'Purchases', recordType: 'order' }];
  assert.deepEqual(orderSurfaceFor('order-a', 'tenant-a', false, desks), { kind: 'order', orderId: 'order-a' });
  assert.deepEqual(orderSurfaceFor('order-a', 'tenant-a', true, desks), { kind: 'operational-desk', title: 'Purchases', params: { deskId: 'a-tenant-chosen-name', projectId: 'tenant-a', recordId: 'order-a' } });
  assert.equal(orderSurfaceFor('order-a', 'tenant-a', true, []), undefined, 'staff cannot fall back to another customer’s private receipt');
  assert.equal(orderSurfaceFor('order-a', 'tenant-a', true, [{ deskId: 'order', title: 'Misleading name' }]), undefined, 'a matching desk name cannot substitute for configured link metadata');
});
