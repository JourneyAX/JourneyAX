/**
 * Service endpoints come from configuration. A development fallback is allowed only outside production;
 * in production a missing endpoint is a startup error rather than a silent localhost call.
 */
export function resolveServiceUrl(
  name: string,
  configured: string | undefined,
  devFallback?: string,
  nodeEnv: string | undefined = process.env.NODE_ENV,
): string {
  const value = (configured || '').trim();
  if (value) return value.replace(/\/+$/, '');
  if (nodeEnv !== 'production' && devFallback) return devFallback;
  throw new Error(`${name} must be configured${nodeEnv === 'production' ? ' in production' : ''}`);
}

/** Recorded as the actor when an operation has no authenticated principal; never a human-looking identity. */
export const UNATTRIBUTED_PRINCIPAL = 'system:unattributed';
