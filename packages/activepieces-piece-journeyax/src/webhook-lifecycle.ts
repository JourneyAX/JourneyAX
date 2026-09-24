import { JourneyAxAuthData } from './auth';

/**
 * Shared authenticated webhook registration lifecycle for all JourneyAX triggers.
 * Binds subscription strictly to connection's tenantId and environmentId.
 */
export async function registerWebhookTrigger(
  eventName: string,
  context: { auth: any; webhookUrl: string; store?: any }
): Promise<string> {
  const auth = context.auth as any as JourneyAxAuthData;
  if (!auth || !auth.baseUrl || !auth.tenantId || !auth.environmentId) {
    throw new Error('Invalid JourneyAX connection: baseUrl, tenantId, and environmentId are required');
  }

  const endpoint = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${auth.tenantId}/${auth.environmentId}/runtime/webhooks/subscriptions`;
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-internal-key': auth.apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      event: eventName,
      webhookUrl: context.webhookUrl,
    }),
  });

  if (!res.ok) {
    const errorText = await res.text().catch(() => '');
    throw new Error(
      `Failed to register webhook trigger '${eventName}' for tenant '${auth.tenantId}' (${auth.environmentId}): HTTP ${res.status} ${res.statusText} - ${errorText}`
    );
  }

  const data: any = await res.json();
  const subscriptionId = data?.subscriptionId;
  if (subscriptionId && context.store && typeof context.store.put === 'function') {
    await context.store.put('subscriptionId', subscriptionId);
  }
  return subscriptionId;
}

/**
 * Shared authenticated webhook unregistration lifecycle for all JourneyAX triggers.
 */
export async function unregisterWebhookTrigger(
  eventName: string,
  context: { auth: any; store?: any }
): Promise<void> {
  const auth = context.auth as any as JourneyAxAuthData;
  if (!auth || !auth.baseUrl || !auth.tenantId || !auth.environmentId) {
    return;
  }

  let subscriptionId: string | null = null;
  if (context.store && typeof context.store.get === 'function') {
    subscriptionId = (await context.store.get('subscriptionId')) as string | null;
  }

  if (!subscriptionId) {
    return;
  }

  const endpoint = `${auth.baseUrl.replace(/\/$/, '')}/api/v1/${auth.tenantId}/${auth.environmentId}/runtime/webhooks/subscriptions/${subscriptionId}`;
  await fetch(endpoint, {
    method: 'DELETE',
    headers: {
      'x-internal-key': auth.apiKey,
    },
  }).catch(() => {});
}
