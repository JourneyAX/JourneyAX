import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { BusinessPackLoader, publishBusinessPack } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { CustomerProfileProvisioner } from '../src/commerce/customer-profile-provisioner';

async function fixture(withOrder = false) {
  const db = new MemoryDb({ transactional: true }); const content: any = structuredClone(rawLegacyFixture);
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  content.extensions.customerProfiles = { enabled: true, sources: [{ connectorId: 'crm', createTool: 'create_profile', readTool: 'read_profile', references: { accountId: 'record.accountId' } }] };
  content.extensions.connectors = { connectors: [{ connectorId: 'crm', displayName: 'CRM', description: 'Profile source', owner: 'Care', connectionRef: 'test-profile', tools: [{ name: 'create_profile', sideEffect: 'write' }, { name: 'read_profile', sideEffect: 'read' }] }], policy: [] };
  if (withOrder) {
    Object.assign(content.extensions.customerProfiles.sources[0], { orderReadTool: 'read_order', orderLinkTool: 'link_order', references: { customerId: 'record.customerId' } });
    content.extensions.connectors.connectors[0].tools.push({ name: 'read_order', sideEffect: 'read' }, { name: 'link_order', sideEffect: 'write' });
  }
  await publishBusinessPack(db as any, content); const release = await new BusinessPackLoader({ db }).loadPublished('placemakers', 'production');
  await db.collection('users').insertOne({ tenantId: 'placemakers', email: 'owned@example.test', fullName: 'Existing Profile', passwordHash: 'must-never-leave', isActive: true });
  const calls: any[] = []; let source: any = null;
  const orderRecord: any = { orderId: 'source-order-a', orderNumber: 'owned-order', version: 4, paymentCustomersLinked: false };
  const dispatcher: any = { dispatch: async (_: any, __: any, request: any, context: any) => {
    calls.push({ request, context });
    if (request.toolId.endsWith('.read_order')) return { status: 'success', output: { data: { record: { ...orderRecord } } } };
    if (request.toolId.endsWith('.link_order')) {
      assert.deepEqual(Object.keys(request.input).sort(), ['email', 'externalCustomerKey', 'orderNumber']);
      Object.assign(orderRecord, { customerId: 'customer-a', version: orderRecord.version + 1, paymentCustomersLinked: true, linkedPaymentIds: ['payment-a'] });
      return { status: 'success', output: { data: { record: { ...orderRecord } } } };
    }
    if (request.toolId.endsWith('.create_profile')) { assert.deepEqual(Object.keys(request.input).sort(), ['email','externalCustomerKey','fullName']); source = { accountId: 'account-a', customerId: 'customer-a', externalCustomerKey: request.input.externalCustomerKey }; }
    return { status: 'success', output: { data: { record: source } } };
  } };
  return { db, release, calls, service: new CustomerProfileProvisioner(db, dispatcher), setSource: (value: any) => { source = value; } };
}
const approval = { reference: 'explicit-owned-profile-approval', approvedOwner: 'owned@example.test', environmentId: 'production' };
async function authority(run: () => Promise<void>) {
  const previous = [process.env.JAX_COMMAND_SIGNING_SECRET, process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET];
  process.env.JAX_COMMAND_SIGNING_SECRET = 'offline-registered-profile-authority'.repeat(2); process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET = process.env.JAX_COMMAND_SIGNING_SECRET;
  try { await run(); } finally { for (const [i,k] of ['JAX_COMMAND_SIGNING_SECRET','JAX_IQ_CONNECTOR_SIGNING_SECRET'].entries()) { if (previous[i] === undefined) delete process.env[k]; else process.env[k] = previous[i]; } }
}
test('only the approved existing tenant profile leaves the server, with scoped source receipts and repeat-safe links', () => authority(async () => {
  const f = await fixture(); const result = await f.service.provision(f.release, approval.approvedOwner, approval);
  assert.equal(result.status, 'ready'); assert.equal(result.references.crm.accountId, 'account-a');
  assert.equal(f.calls.filter(c => c.request.toolId.endsWith('.create_profile')).length, 1);
  assert.doesNotMatch(JSON.stringify(f.calls), /passwordHash|must-never-leave/);
  await f.service.provision(f.release, approval.approvedOwner, approval);
  assert.equal(f.calls.filter(c => c.request.toolId.endsWith('.create_profile')).length, 1);
  assert.equal(f.db.dump('customer_profile_links').length, 1);
}));
test('owned historical order linkage is receipt-based and repeated runs do not issue another command', () => authority(async () => {
  const f = await fixture(true);
  await f.db.collection('orders').insertOne({ tenantId: 'placemakers', environmentId: 'production', principalId: approval.approvedOwner, orderId: 'owned-order', status: 'paid', externalOrder: { system: 'crm', orderId: 'source-order-a' } });
  await f.service.provision(f.release, approval.approvedOwner, approval, 'owned-order');
  await f.service.provision(f.release, approval.approvedOwner, approval, 'owned-order');
  assert.equal(f.calls.filter(c => c.request.toolId.endsWith('.link_order')).length, 1);
  assert.equal(f.db.dump('orders')[0].customerLinkReceipt.version, 5);
  assert.equal(f.db.dump('orders')[0].customerProfile.references.crm.customerId, 'customer-a');
  await assert.rejects(() => f.service.provision(f.release, approval.approvedOwner, approval, 'another-principals-order'), /profile owner/);
}));
test('wrong owner, environment, inactive login and conflicting source identity cannot acquire a link', () => authority(async () => {
  const f = await fixture();
  await assert.rejects(() => f.service.provision(f.release, 'someone@example.test', approval), /approval/);
  await assert.rejects(() => f.service.provision(f.release, approval.approvedOwner, { ...approval, environmentId: 'test' }), /approval/);
  assert.equal(f.calls.length, 0);
  f.setSource({ accountId: 'another-account', externalCustomerKey: 'another-customer' });
  await assert.rejects(() => f.service.provision(f.release, approval.approvedOwner, approval), /canonical identity/);
  assert.equal(f.db.dump('customer_profile_links').length, 0);
  await f.db.collection('users').updateOne({ email: approval.approvedOwner }, { $set: { isActive: false } });
  await assert.rejects(() => f.service.provision(f.release, approval.approvedOwner, approval), /existing approved tenant profile/);
}));
