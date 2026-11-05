import './setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpIqClient, signIqRequest, verifyIqRequest, IQ_ASSERTION_HEADER, type IqContext } from '../src';
const context: IqContext = { tenantId: 'tenant-a', environmentId: 'test', queryId: 'q-a', correlationId: 'trace-a', release: { version: '1', checksum: 'abc' }, disabledConnectors: ['crm'], principal: { id: 'staff-a', audience: 'staff', groups: ['service'], subjects: [] } };
const query: any = { operation: 'get', subject: { thing: 'Ticket', canonicalId: '7' }, facts: ['Ticket.subject'] };
const source = { system: 'support', displayName: 'Support', sample: false, tool: 'get_ticket', authority: 'source_of_truth', sourceUpdatedAt: null, retrievedAt: '2026-11-02T00:00:00Z', fromCache: false, asOf: { kind: 'as_read_at', at: '2026-11-02T00:00:00Z' } };
const response: any = { ok: true, queryId: context.queryId, release: context.release, status: 'complete', untrustedText: true, sources: [{ system: 'support', sample: false, truncated: false }], records: [{ subject: query.subject, facts: [{ fact: 'Ticket.subject', status: 'ok', value: 'Recorded issue', source, bindingIds: ['binding-a'], notes: [], crossChecks: [] }] }] };
const secret = 'fixture-query-signing-secret-over-32-chars';
const client = (body: unknown) => new HttpIqClient({ baseUrl: () => 'https://iq.example.test', secret: () => secret, fetchImpl: async () => Response.json(body) });

test('the IQ wire preserves turn-specific source restrictions in the signed context', () => {
  const token = signIqRequest(context, query, secret);
  assert.deepEqual(verifyIqRequest(token, query, secret, context).context.disabledConnectors, ['crm']);
});

test('valid source facts enter the model only with their complete provenance and matching requested subject', async () => {
  assert.deepEqual(await client(response).query(query, context), response);
  for (const change of [
    (body: any) => { body.records[0].subject.canonicalId = 'another-ticket'; },
    (body: any) => { delete body.records[0].facts[0].source; },
    (body: any) => { body.records[0].facts[0].fact = 'Ticket.privateNotes'; },
    (body: any) => { body.sources[0].sample = 'false'; },
    (body: any) => { body.status = 'invented'; },
    (body: any) => { body.untrustedText = false; },
  ]) {
    const malformed = structuredClone(response); change(malformed);
    const answer = await client(malformed).query(query, context);
    assert.equal(answer.ok, false);
    assert.equal(!answer.ok && answer.code, 'release_unavailable');
  }
});

test('hosted IAM headers accompany, but cannot replace, the exact signed IQ request', async () => {
  let seen = false;
  const hosted = new HttpIqClient({ baseUrl: () => 'https://iq-test.run.app', secret: () => secret, serviceHeaders: async audience => { assert.equal(audience, 'https://iq-test.run.app'); return { 'X-Serverless-Authorization': 'Bearer fixture-cloud-identity' }; }, fetchImpl: async (_url, init) => {
    const headers = new Headers(init?.headers); assert.equal(headers.get('X-Serverless-Authorization'), 'Bearer fixture-cloud-identity');
    const signature = headers.get(IQ_ASSERTION_HEADER);
    assert.ok(signature); verifyIqRequest(signature!, query, secret, context); seen = true;
    return Response.json(response);
  } });
  assert.equal((await hosted.query(query, context)).ok, true); assert.equal(seen, true);
});
