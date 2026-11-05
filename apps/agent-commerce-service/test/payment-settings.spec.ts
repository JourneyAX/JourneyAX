import '../../../packages/jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { MemoryDb } from '@journeyax/test-support';
import { PackRepository, publishBusinessPack, validateBusinessPack } from '@journeyax/business-pack';
import { EnvSecretResolver, connectorSecretVariable } from '@journeyax/capability-sdk';
import { rawLegacyFixture } from '../../../packages/business-pack/test/fixtures/legacy-pack.fixture';
import { stripePaymentSettings, checkoutReturnUrl } from '../src/commerce/payment-settings';
import { OrderService } from '../src/commerce/order.service';

async function fixture() {
  const content: any = structuredClone(rawLegacyFixture);
  content.extensions = { ...content.extensions, payment: { stripe: { mode: 'test', secretRef: 'tenant-secret://placemakers/production/payments-private', publishableKeyRef: 'tenant-secret://placemakers/production/payments-public', webhookSecretRef: 'tenant-secret://placemakers/production/payments-webhook' }, returnOrigins: ['https://merchant.example.test'] } };
  if (content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled = false;
  const db = new MemoryDb();
  await publishBusinessPack(db as any, content);
  const pack = await new PackRepository(db as any).loadActivePack('placemakers', 'production');
  const refs = content.extensions.payment.stripe;
  const env = { [connectorSecretVariable(refs.secretRef)]: 'sk_test_fixture', [connectorSecretVariable(refs.publishableKeyRef)]: 'pk_test_fixture', [connectorSecretVariable(refs.webhookSecretRef)]: 'whsec_fixture' };
  return { pack, content, secrets: new EnvSecretResolver(env) };
}

test('payment credentials come only from exact tenant/environment references on a verified release', async () => {
  const { pack, secrets, content } = await fixture();
  const resolved = await stripePaymentSettings(pack, { tenantId: 'placemakers', environmentId: 'production' }, secrets);
  assert.equal(resolved.stripe.secretKey, 'sk_test_fixture');
  assert.equal(await resolved.webhookSecret(), 'whsec_fixture');
  await assert.rejects(() => stripePaymentSettings(pack, { tenantId: 'other-tenant', environmentId: 'production' }, secrets), /verified/);
  await assert.rejects(() => stripePaymentSettings(pack, { tenantId: 'placemakers', environmentId: 'test' }, secrets), /verified/);
  await assert.rejects(() => stripePaymentSettings(content, { tenantId: 'placemakers', environmentId: 'production' }, secrets), /verified/);
  await assert.rejects(() => stripePaymentSettings(pack, { tenantId: 'placemakers', environmentId: 'production' }, new EnvSecretResolver({ STRIPE_SECRET_KEY: 'sk_test_shared' })), /configured/);
  content.extensions.payment.stripe.secretRef = 'tenant-secret://other-tenant/production/payments-private';
  assert.equal(validateBusinessPack(content).valid, false);
});

test('checkout return addresses stay on configured shop origins', () => {
  const allowed = ['https://merchant.example.test'];
  const fallback = 'https://merchant.example.test/?order={ORDER_ID}';
  assert.equal(checkoutReturnUrl(undefined, fallback, allowed), fallback);
  for (const url of ['https://attacker.test/steal', 'javascript:alert(1)', 'https://user:password@merchant.example.test/']) assert.throws(() => checkoutReturnUrl(url, fallback, allowed));
});

test('a real Stripe-signed test event must match environment, owner and exact quote revision', async () => {
  const order: any = { orderId: 'ord-fixture', tenantId: 'tenant-a', environmentId: 'test', principalId: 'customer-a', quoteId: 'quote-a', quoteVersion: 3, stripeSessionId: 'cs-fixture', status: 'pending_payment', total: 10, currency: 'NZD' };
  const db = new MemoryDb({ transactional: true });
  await db.collection('orders').insertOne(order);
  await db.collection('quotes').insertOne({ tenantId: order.tenantId, environmentId: 'test', principalId: order.principalId, quoteId: order.quoteId, version: 3, status: 'draft', checkoutOrderId: order.orderId });
  const service = new OrderService(async () => db);
  const stripe = new Stripe('sk_test_fixture');
  const receipt = { id: 'cs-fixture', status: 'complete', payment_status: 'paid', livemode: false, amount_total: 1000, currency: 'nzd', metadata: { orderId: order.orderId, tenantId: order.tenantId, environmentId: 'test', principalId: order.principalId, quoteId: order.quoteId, quoteVersion: '2' } };
  const send = async () => {
    const payload = JSON.stringify({ id: 'evt_fixture', object: 'event', type: 'checkout.session.completed', data: { object: receipt } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_fixture' });
    return service.handleWebhook(payload, signature, 'sk_test_fixture', 'tenant-a', { environmentId: 'test', secret: 'whsec_fixture' });
  };
  assert.equal((await send()).ok, false);
  assert.equal(order.status, 'pending_payment');
  receipt.metadata.quoteVersion = '3';
  assert.equal((await send()).ok, true);
  assert.equal(db.dump('orders')[0].status, 'paid');
  assert.equal(db.dump('orders')[0].commerceSync.status, 'pending');
});
