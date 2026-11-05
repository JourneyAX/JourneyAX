import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { zendesk } from '../src/connectors/zendesk';

test('ticket totals come from the scoped provider count endpoint, preserve zero, and never use a page length or fabricate a missing count', async () => {
  let count: any = 26; const urls: URL[] = [];
  const source = zendesk({ ZENDESK_API_URL: 'https://synthetic.invalid', ZENDESK_EMAIL: 'fixture@example.test', ZENDESK_API_TOKEN: 'fixture' }, { now: () => Date.parse('2026-11-02T00:00:00Z'), fetchImpl: async url => { urls.push(new URL(String(url))); return new Response(JSON.stringify({ count })); } });
  const tool = source.tools.find(tool => tool.name === 'count_tickets')!;
  assert.equal(tool.staffOnly, true);
  assert.equal((await tool.run({ status: 'unsolved' })).record.count, 26);
  assert.equal(urls[0].pathname, '/api/v2/search/count');
  assert.equal(urls[0].searchParams.get('query'), 'type:ticket status<solved');
  count = 0; assert.equal((await tool.run({ status: 'open' })).record.count, 0);
  count = undefined; await assert.rejects(() => tool.run({}), /valid count/);
  const calls = urls.length; await assert.rejects(() => tool.run({ status: 'open OR type:user' }), /Unsupported/); assert.equal(urls.length, calls);
});
