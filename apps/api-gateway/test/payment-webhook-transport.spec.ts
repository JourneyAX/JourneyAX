import test from 'node:test';
import assert from 'node:assert/strict';
import { paymentWebhookTransport } from '../src/gateway.service';
test('only the exact tenant payment callback forwards its signature and byte-identical body', () => {
  const raw = Buffer.from('{ "id": "test_event",\n  "data": {"literal":"é"} }\n');
  const headers = { 'stripe-signature': 'unit-test-signature' };
  const result = paymentWebhookTransport('POST', '/api/v1/merchant-a/commerce/stripe/test/webhook', headers, raw)!;
  assert.equal(result.body, raw); assert.equal(result.signature, headers['stripe-signature']);
  assert.notDeepEqual(result.body, Buffer.from(JSON.stringify(JSON.parse(raw.toString()))));
  assert.equal(paymentWebhookTransport('POST', '/api/v1/merchant-a/commerce/chat', headers, raw), undefined);
  assert.throws(() => paymentWebhookTransport('POST', '/api/v1/merchant-a/commerce/stripe/test/webhook', headers), /exact signed/);
  assert.throws(() => paymentWebhookTransport('POST', '/api/v1/merchant-a/commerce/stripe/test/webhook', {}, raw), /exact signed/);
});
