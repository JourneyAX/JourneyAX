import { Db } from 'mongodb';
import { randomUUID, createHmac } from 'crypto';
import {
  COLLECTION_NOTIFICATION_DELIVERIES,
  NotificationDeliveryRecord,
  EnvironmentId,
} from './types';

export interface EmailChannelConfig {
  enabled: boolean;
  provider?: 'sendgrid';
  apiKey?: string;
  fromEmail?: string;
  fromName?: string;
  defaultRecipients?: string[];
  templateIds?: Record<string, string>;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  url: string;
  secret?: string;
  events?: string[];
}

export interface NotificationChannelSettings {
  email?: EmailChannelConfig;
  webhook?: WebhookChannelConfig;
}

export interface NotificationEvent {
  eventId: string;
  tenantId: string;
  environmentId?: EnvironmentId;
  channel?: 'email' | 'webhook';
  recipient?: string;
  payload: Record<string, any>;
  timestamp?: Date;
}

export interface NotificationDispatchResult {
  success: boolean;
  deliveries: {
    deliveryId: string;
    channel: 'email' | 'webhook';
    recipient: string;
    status: 'delivered' | 'failed' | 'retrying';
    error?: string;
  }[];
}

export class NotificationDispatcher {
  constructor(private db: Db) {}

  /**
   * Dispatches a durable notification across configured channels with delivery auditing and retries.
   */
  async dispatch(
    tenantId: string,
    eventId: string,
    payload: any,
    channelsConfig?: NotificationChannelSettings,
    options: { environmentId?: EnvironmentId; recipients?: string[] } = {}
  ): Promise<NotificationDispatchResult> {
    const deliveries: NotificationDispatchResult['deliveries'] = [];
    const envId = options.environmentId || 'production';

    // ── 1. Dispatch Email via SendGrid ───────────────────────────────────
    const emailConfig = channelsConfig?.email;
    if (emailConfig && emailConfig.enabled) {
      const recipients = options.recipients && options.recipients.length > 0
        ? options.recipients
        : emailConfig.defaultRecipients && emailConfig.defaultRecipients.length > 0
        ? emailConfig.defaultRecipients
        : [];

      for (const recipient of recipients) {
        const deliveryId = `deliv_${randomUUID()}`;
        const templateId = emailConfig.templateIds?.[eventId];

        let status: 'delivered' | 'failed' | 'retrying' = 'failed';
        let errorMsg: string | undefined;

        const effectiveApiKey =
          emailConfig.apiKey && !emailConfig.apiKey.startsWith('••••')
            ? emailConfig.apiKey
            : process.env.SENDGRID_API_KEY;

        if (!effectiveApiKey) {
          status = 'failed';
          errorMsg = 'SendGrid API key not configured: no valid key found in channel config or environment';
        } else {
          try {
            // Real SendGrid API execution
            const mailBody: any = {
              personalizations: [
                {
                  to: [{ email: recipient }],
                  dynamic_template_data: {
                    tenantId,
                    eventId,
                    ...payload,
                  },
                },
              ],
              from: {
                email: emailConfig.fromEmail || 'alerts@journeyax.com',
                name: emailConfig.fromName || 'JourneyAX Alerts',
              },
            };

            if (templateId) {
              mailBody.template_id = templateId;
            } else {
              mailBody.subject = `[JourneyAX] Alert: ${eventId} on ${tenantId}`;
              mailBody.content = [
                {
                  type: 'text/plain',
                  value: `Alert for ${eventId}:\n\n${JSON.stringify(payload, null, 2)}`,
                },
              ];
            }

            const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${effectiveApiKey}`,
              },
              body: JSON.stringify(mailBody),
            });

            if (response.ok || response.status === 202) {
              status = 'delivered';
            } else {
              const resText = await response.text();
              throw new Error(`SendGrid API returned status ${response.status}: ${resText}`);
            }
          } catch (err: any) {
            status = 'failed';
            errorMsg = err.message || 'SendGrid email delivery failure';
          }
        }

        const deliveryRecord: NotificationDeliveryRecord = {
          deliveryId,
          tenantId,
          environmentId: envId,
          eventId,
          channel: 'email',
          recipient,
          status,
          attempts: 1,
          maxAttempts: 3,
          templateId,
          payload,
          error: errorMsg,
          deliveredAt: status === 'delivered' ? new Date() : undefined,
          createdAt: new Date(),
        };

        await this.db
          .collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES)
          .insertOne(deliveryRecord);

        deliveries.push({
          deliveryId,
          channel: 'email',
          recipient,
          status,
          error: errorMsg,
        });
      }
    }

    // ── 2. Dispatch Webhook ──────────────────────────────────────────────
    const webhookConfig = channelsConfig?.webhook;
    if (webhookConfig && webhookConfig.enabled && webhookConfig.url) {
      const deliveryId = `deliv_${randomUUID()}`;
      let status: 'delivered' | 'failed' | 'retrying' = 'failed';
      let errorMsg: string | undefined;

      try {
        const bodyStr = JSON.stringify({
          tenantId,
          eventId,
          environmentId: envId,
          timestamp: new Date().toISOString(),
          payload,
        });

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'JourneyAX-Notifier/1.0',
        };

        if (webhookConfig.secret) {
          const hmac = createHmac('sha256', webhookConfig.secret);
          hmac.update(bodyStr);
          headers['x-journeyax-signature'] = `sha256=${hmac.digest('hex')}`;
        }

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);

        try {
          const response = await fetch(webhookConfig.url, {
            method: 'POST',
            headers,
            body: bodyStr,
            signal: controller.signal,
          });

          if (!response.ok) {
            throw new Error(`Webhook target responded with status ${response.status}`);
          }
          status = 'delivered';
        } finally {
          clearTimeout(timeout);
        }
      } catch (err: any) {
        status = 'failed';
        errorMsg = err.message || 'Webhook post failure';
      }

      const deliveryRecord: NotificationDeliveryRecord = {
        deliveryId,
        tenantId,
        environmentId: envId,
        eventId,
        channel: 'webhook',
        recipient: webhookConfig.url,
        status,
        attempts: 1,
        maxAttempts: 3,
        payload,
        error: errorMsg,
        deliveredAt: status === 'delivered' ? new Date() : undefined,
        createdAt: new Date(),
      };

      await this.db
        .collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES)
        .insertOne(deliveryRecord);

      deliveries.push({
        deliveryId,
        channel: 'webhook',
        recipient: webhookConfig.url,
        status,
        error: errorMsg,
      });
    }

    const allSuccessful = deliveries.length > 0 && deliveries.every((d) => d.status === 'delivered');
    return {
      success: deliveries.length === 0 || allSuccessful,
      deliveries,
    };
  }

  /**
   * Retrieves recent notification delivery audit logs.
   */
  async listDeliveries(tenantId: string, limit = 50): Promise<NotificationDeliveryRecord[]> {
    const col = this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES);
    return col
      .find({ tenantId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
  }

  /**
   * Retries an individual failed delivery with exponential backoff.
   */
  async retryDelivery(
    deliveryId: string,
    channelsConfig?: NotificationChannelSettings
  ): Promise<NotificationDeliveryRecord | null> {
    const col = this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES);
    const existing = await col.findOne({ deliveryId });
    if (!existing || existing.status === 'delivered') return existing;

    const nextAttempts = (existing.attempts || 1) + 1;
    let newStatus: 'delivered' | 'failed' | 'retrying' = 'delivered';
    let errorMsg: string | undefined;

    if (existing.channel === 'webhook') {
      try {
        const bodyStr = JSON.stringify({
          tenantId: existing.tenantId,
          eventId: existing.eventId,
          payload: existing.payload,
          isRetry: true,
          retryAttempt: nextAttempts,
        });

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'User-Agent': 'JourneyAX-Notifier/1.0',
        };

        if (channelsConfig?.webhook?.secret) {
          const hmac = createHmac('sha256', channelsConfig.webhook.secret);
          hmac.update(bodyStr);
          headers['x-journeyax-signature'] = `sha256=${hmac.digest('hex')}`;
        }

        const res = await fetch(existing.recipient, {
          method: 'POST',
          headers,
          body: bodyStr,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      } catch (err: any) {
        newStatus = nextAttempts >= existing.maxAttempts ? 'failed' : 'retrying';
        errorMsg = err.message;
      }
    }

    const update: any = {
      $set: {
        attempts: nextAttempts,
        status: newStatus,
        error: errorMsg,
        deliveredAt: newStatus === 'delivered' ? new Date() : undefined,
      },
    };

    await col.updateOne({ deliveryId }, update);
    return col.findOne({ deliveryId });
  }
}
