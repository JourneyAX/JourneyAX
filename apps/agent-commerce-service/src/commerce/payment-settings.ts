import { getVerifiedBusinessPackMetadata, type BusinessPackRelease } from '@journeyax/business-pack';
import { EnvSecretResolver, type SecretResolver } from '@journeyax/capability-sdk';

/** Values exist only at the payment boundary; neither the model nor the browser receives private credentials. */
export async function stripePaymentSettings(pack: BusinessPackRelease, scope: { tenantId: string; environmentId: string }, secrets: SecretResolver = new EnvSecretResolver()) {
  const verified = getVerifiedBusinessPackMetadata(pack);
  const payment = pack.extensions?.payment;
  const binding = payment?.stripe;
  if (!verified || verified.tenantId !== scope.tenantId || verified.environmentId !== scope.environmentId || !binding || binding.mode !== 'test') throw new Error('A verified test payment connection is required.');
  const secretKey = await secrets.resolve(binding.secretRef, scope);
  const publishableKey = await secrets.resolve(binding.publishableKeyRef, scope);
  if ((!secretKey.startsWith('sk_test_') && !secretKey.startsWith('rk_test_')) || !publishableKey.startsWith('pk_test_')) throw new Error('The payment connection must use test credentials.');
  return { payment, stripe: { secretKey, publishableKey, secretRef: binding.secretRef, publishableKeyRef: binding.publishableKeyRef }, webhookSecret: async () => {
    if (!binding.webhookSecretRef) throw new Error('A scoped webhook connection is required.');
    const value = await secrets.resolve(binding.webhookSecretRef, scope);
    if (!value.startsWith('whsec_')) throw new Error('The webhook connection is invalid.');
    return value;
  } };
}

export function checkoutReturnUrl(value: unknown, fallback: string, allowedOrigins: readonly string[]): string {
  const candidate = value === undefined ? fallback : value;
  if (typeof candidate !== 'string' || candidate.length > 2000) throw new Error('Invalid checkout return address.');
  const url = new URL(candidate);
  if (url.username || url.password || !allowedOrigins.includes(url.origin) || !['https:', 'http:'].includes(url.protocol)) throw new Error('The checkout return address is not configured for this shop.');
  return candidate;
}
