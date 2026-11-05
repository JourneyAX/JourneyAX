import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { salesforce } from '../src/connectors/salesforce';
import { commercetools } from '../src/connectors/commercetools';

const sfId = '001000000000001AAA';
test('CRM contact correction carries an atomic provider ETag and confirms the exact saved phone', async () => {
  let version = 1, phone = '+64210000001'; const writes: any[] = [];
  const source = salesforce({ SALESFORCE_INSTANCE_URL: 'https://synthetic.invalid', SALESFORCE_ACCESS_TOKEN: 'fixture-token' }, { now: Date.now, fetchImpl: async (_url, init) => {
    if (init?.method === 'PATCH') {
      writes.push(init); assert.equal((init.headers as any)['If-Match'], `"v${version}"`);
      phone = JSON.parse(String(init.body)).Phone; version++;
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify({ Id: sfId, Name: 'DEMO account', Phone: phone, LastModifiedDate: '2026-11-02T00:00:00Z' }), { headers: { etag: `"v${version}"` } });
  } });
  const get = source.tools.find(t => t.name === 'get_account_contact')!;
  const command = source.tools.find(t => t.name === 'correct_account_phone')!;
  assert.equal(command.staffOnly, true); assert.equal(command.readOnly, false);
  const before = await get.run({ accountId: sfId });
  const receipt = await command.run({ accountId: sfId, expectedEtag: before.record.etag, phone: '+64210000002' });
  assert.equal(receipt.updated, true); assert.equal(writes.length, 1);
  assert.equal(JSON.stringify(receipt).includes('+64210000002'), false);
  await assert.rejects(() => command.run({ accountId: sfId, expectedEtag: before.record.etag, phone: '+64210000003' }), /changed/);
  assert.equal(writes.length, 1, 'stale approval has no write');
});

test('a concurrent CRM write rejected by the provider is never reported as a successful update or blindly retried', async () => {
  let patches = 0;
  const source = salesforce({ SALESFORCE_INSTANCE_URL: 'https://synthetic.invalid', SALESFORCE_ACCESS_TOKEN: 'fixture-token' }, { now: Date.now, fetchImpl: async (_url, init) => {
    if (init?.method === 'PATCH') { patches++; return new Response('{}', { status: 412 }); }
    return new Response(JSON.stringify({ Id: sfId, Phone: '+64210000001' }), { headers: { etag: '"v1"' } });
  } });
  await assert.rejects(() => source.tools.find(t => t.name === 'correct_account_phone')!.run({ accountId: sfId, expectedEtag: '"v1"', phone: '+64210000002' }), (error: any) => error.code === 'revision_conflict');
  assert.equal(patches, 1);
});

test('commerce contact correction selects the intended address, preserves every untouched field and refuses stale or missing addresses', async () => {
  let unit: any = { key: 'demo-account', version: 4, addresses: [{ id: 'billing', country: 'NZ', city: 'Billing city', phone: '+64210000001' }, { id: 'delivery', country: 'NZ', city: 'Delivery city', mobile: '+64210000002', custom: { type: { id: 'type-a' }, fields: { note: 'Keep this' } } }] };
  let writes = 0;
  const source = commercetools({ COMMERCETOOLS_PROJECT_KEY: 'demo', COMMERCETOOLS_CLIENT_ID: 'demo', COMMERCETOOLS_CLIENT_SECRET: 'demo', COMMERCETOOLS_REGION: 'europe-west1.gcp' }, { now: Date.now, fetchImpl: async (url, init) => {
    if (String(url).includes('/oauth/token')) return new Response(JSON.stringify({ access_token: 'fixture-token', expires_in: 3600 }));
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body)); writes++;
      assert.equal(body.version, unit.version); assert.equal(body.actions[0].addressId, 'delivery');
      unit = { ...unit, version: unit.version + 1, addresses: unit.addresses.map((address: any) => address.id === body.actions[0].addressId ? body.actions[0].address : address) };
    }
    return new Response(JSON.stringify(unit));
  } });
  const command = source.tools.find(t => t.name === 'correct_account_address_contact')!;
  const args = { unitKey: 'demo-account', expectedVersion: 4, addressId: 'delivery', field: 'mobile', value: '+64210000003' };
  const before = structuredClone(unit);
  const receipt = await command.run(args);
  assert.equal(command.staffOnly, true); assert.equal(receipt.updated, true);
  assert.deepEqual(unit.addresses[0], before.addresses[0]);
  assert.deepEqual(unit.addresses[1].custom, before.addresses[1].custom);
  assert.equal(unit.addresses[1].city, 'Delivery city'); assert.equal(unit.addresses[1].mobile, args.value);
  await assert.rejects(() => command.run(args), /changed/);
  await assert.rejects(() => command.run({ ...args, expectedVersion: 5, addressId: 'missing' }), /not recorded/);
  await assert.rejects(() => command.run({ ...args, unitKey: undefined }), /exact account/);
  assert.equal(writes, 1);
});
