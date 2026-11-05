import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { salesforceCustomerProfile, commerceCustomerProfile } from '../src/connectors/customer-profile';

const canonical = 'jax_' + 'a'.repeat(64), contact = '003000000000001AAA', account = '001000000000001AAA', customer = '4b5c84e2-c0e0-4809-8e64-b768bf080e15';

test('CRM canonical profile reads use the exact contact ID and return no personal profile fields', async () => {
  const calls: any[] = [];
  const tools = salesforceCustomerProfile(async (method, path, request) => { calls.push({ method, path, request }); return { totalSize: 1, records: [{ Id: contact, AccountId: account, Name: 'Private name', Email: 'private@example.test', Account: { Description: `JourneyAX customer reference: ${canonical}` } }] }; }, () => 'v62.0');
  const tool = tools.find(tool => tool.name === 'get_customer_profile')!;
  const result = await tool.run({ contactId: contact });
  assert.deepEqual(result.record, { accountId: account, contactId: contact, externalCustomerKey: canonical });
  assert.equal(calls[0].method, 'GET'); assert.match(calls[0].request.query.q, new RegExp(`WHERE Id = '${contact}' LIMIT 2`));
  assert.doesNotMatch(JSON.stringify(result), /Private name|private@example/);
  await assert.rejects(() => tool.run({ contactId: `${contact}' OR Id != null` }), /exact CRM contact/);
});

test('commerce canonical profile reads reject a mismatched source ID or an unregistered external reference', async () => {
  let row: any = { id: customer, key: canonical, version: 3, email: 'private@example.test', firstName: 'Private' };
  const tool = commerceCustomerProfile(async (method, path) => { assert.equal(method, 'GET'); assert.equal(path, `/customers/${customer}`); return row; }).find(tool => tool.name === 'get_customer_profile')!;
  assert.deepEqual((await tool.run({ customerId: customer })).record, { customerId: customer, externalCustomerKey: canonical, version: 3 });
  row = { ...row, id: 'wrong' }; await assert.rejects(() => tool.run({ customerId: customer }), /exact registered/);
  row = { id: customer, version: 3 }; await assert.rejects(() => tool.run({ customerId: customer }), /exact registered/);
});
