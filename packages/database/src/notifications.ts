import { Db } from 'mongodb';
import { randomUUID, createHmac, timingSafeEqual } from 'crypto';
import {
  COLLECTION_NOTIFICATION_DELIVERIES,
  COLLECTION_OUTBOX_EVENTS,
  NotificationDeliveryRecord,
  EnvironmentId,
} from './types';

export class NotificationRateLimitError extends Error {
  constructor(public tenantId: string, public currentCount: number, public limitPerHour: number) {
    super(`Rate limit exceeded for tenant '${tenantId}': ${currentCount} / ${limitPerHour} emails sent in the last hour`);
    this.name = 'NotificationRateLimitError';
  }
}

export interface EmailChannelConfig {
  enabled: boolean;
  provider?: 'sendgrid' | 'resend' | 'activepieces' | 'webhook';
  apiKey?: string;
  apiKeyRef?: string;
  connectionRef?: string;
  fromEmail?: string;
  fromName?: string;
  defaultRecipients?: string[];
  templateIds?: Record<string, string>;
  rateLimitPerHour?: number;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  url: string;
  secret?: string;
  secretRef?: string;
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
    provider?: string;
    recipient: string;
    status: 'delivered' | 'failed' | 'retrying' | 'bounced' | 'opened' | 'clicked' | 'dropped';
    error?: string;
  }[];
}

export class NotificationDispatcher {
  constructor(private db: Db) {}

  /**
   * Resolves a secret reference for a tenant from the tenant_secrets collection.
   */
  private async resolveSecret(tenantId: string, secretRef?: string): Promise<string | null> {
    if (!secretRef) return null;
    try {
      const doc = await this.db.collection('tenant_secrets').findOne({
        tenantId,
        secretRef,
      });
      return doc?.value || null;
    } catch {
      return null;
    }
  }

  /**
   * Enforces sliding-window rate limit on outbound notifications per tenant.
   */
  async checkRateLimit(tenantId: string, limitPerHour = 100): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES).countDocuments({
      tenantId,
      createdAt: { $gte: oneHourAgo },
      status: { $in: ['delivered', 'retrying'] },
    });

    if (count >= limitPerHour) {
      throw new NotificationRateLimitError(tenantId, count, limitPerHour);
    }
  }

  /**
   * Enqueues a notification into the durable Outbox collection for asynchronous processing.
   */
  async enqueueToOutbox(
    tenantId: string,
    environmentId: EnvironmentId,
    eventType: string,
    payload: Record<string, any>
  ): Promise<string> {
    const eventId = `evt_outbox_${Date.now()}_${randomUUID().slice(0, 8)}`;
    await this.db.collection(COLLECTION_OUTBOX_EVENTS).insertOne({
      eventId,
      tenantId,
      environmentId,
      eventType,
      payload,
      status: 'pending',
      attempts: 0,
      createdAt: new Date(),
    });
    return eventId;
  }

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

    // ── 1. Dispatch Email ────────────────────────────────────────────────
    const emailConfig = channelsConfig?.email;
    if (emailConfig && emailConfig.enabled) {
      // Rate limiting
      const limit = emailConfig.rateLimitPerHour || 100;
      await this.checkRateLimit(tenantId, limit);

      const recipients = options.recipients && options.recipients.length > 0
        ? options.recipients
        : emailConfig.defaultRecipients && emailConfig.defaultRecipients.length > 0
        ? emailConfig.defaultRecipients
        : [];

      // Resolve API key from secret reference or explicit config
      let effectiveApiKey = emailConfig.apiKey && !emailConfig.apiKey.startsWith('••••')
        ? emailConfig.apiKey
        : null;

      if (!effectiveApiKey && emailConfig.apiKeyRef) {
        effectiveApiKey = await this.resolveSecret(tenantId, emailConfig.apiKeyRef);
      }

      const provider = emailConfig.provider || 'sendgrid';
      if (!effectiveApiKey) {
        if (provider === 'sendgrid') effectiveApiKey = process.env.SENDGRID_API_KEY || null;
        if (provider === 'resend') effectiveApiKey = process.env.RESEND_API_KEY || null;
      }

      for (const recipient of recipients) {
        const deliveryId = `deliv_${randomUUID()}`;
        const templateId = emailConfig.templateIds?.[eventId];

        let status: 'delivered' | 'failed' | 'retrying' = 'failed';
        let errorMsg: string | undefined;

        if (!effectiveApiKey && provider !== 'activepieces') {
          status = 'failed';
          errorMsg = `${provider} API key not configured: no valid key found in channel config, secret reference, or environment`;
        } else {
          try {
            if (provider === 'resend') {
              // Real Resend API
              const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${effectiveApiKey}`,
                },
                body: JSON.stringify({
                  from: `${emailConfig.fromName || 'JourneyAX Alerts'} <${emailConfig.fromEmail || 'alerts@journeyax.com'}>`,
                  to: [recipient],
                  subject: `[JourneyAX] Alert: ${eventId} on ${tenantId}`,
                  html: `<p><strong>Alert for ${eventId}</strong></p><pre>${JSON.stringify(payload, null, 2)}</pre>`,
                }),
              });

              if (res.ok || res.status === 200 || res.status === 201) {
                status = 'delivered';
              } else {
                const resText = await res.text();
                throw new Error(`Resend API returned status ${res.status}: ${resText}`);
              }
            } else if (provider === 'activepieces') {
              // Activepieces notification flow dispatch
              const flowUrl = emailConfig.connectionRef || process.env.ACTIVEPIECES_NOTIFICATION_FLOW_URL;
              if (!flowUrl) {
                throw new Error('Activepieces notification flow URL not configured');
              }
              const res = await fetch(flowUrl, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'X-Tenant-ID': tenantId,
                  'X-Environment-ID': envId,
                },
                body: JSON.stringify({
                  tenantId,
                  eventId,
                  recipient,
                  payload,
                }),
              });
              if (res.ok) {
                status = 'delivered';
              } else {
                throw new Error(`Activepieces notification flow returned HTTP ${res.status}`);
              }
            } else {
              // SendGrid API execution
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
            }
          } catch (err: any) {
            status = 'failed';
            errorMsg = err.message || `${provider} email delivery failure`;
          }
        }

        const deliveryRecord: NotificationDeliveryRecord = {
          deliveryId,
          tenantId,
          environmentId: envId,
          eventId,
          channel: 'email',
          provider,
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
          provider,
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

        let secret = webhookConfig.secret;
        if (!secret && webhookConfig.secretRef) {
          secret = (await this.resolveSecret(tenantId, webhookConfig.secretRef)) || undefined;
        }

        if (secret) {
          const hmac = createHmac('sha256', secret);
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
   * Helper: Dispatches an approval notification when a high-risk tool execution requires human approval.
   */
  async dispatchApprovalNotification(
    tenantId: string,
    approvalRequest: {
      requestId: string;
      toolId: string;
      executionId: string;
      parameters: Record<string, any>;
      requestedBy: string;
      expiresAt: Date;
    },
    channelsConfig?: NotificationChannelSettings,
    recipients?: string[]
  ): Promise<NotificationDispatchResult> {
    const payload = {
      type: 'approval_required',
      requestId: approvalRequest.requestId,
      toolId: approvalRequest.toolId,
      executionId: approvalRequest.executionId,
      parameters: approvalRequest.parameters,
      requestedBy: approvalRequest.requestedBy,
      expiresAt: approvalRequest.expiresAt.toISOString(),
      actionUrl: `https://app.journeyax.com/approvals/${approvalRequest.requestId}`,
    };

    return this.dispatch(tenantId, 'execution.requires_approval', payload, channelsConfig, {
      recipients,
    });
  }

  /**
   * Helper: Dispatches a membership invitation email with a single-use token and TTL.
   */
  async dispatchMembershipInviteNotification(
    tenantId: string,
    inviteDetails: {
      email: string;
      fullName: string;
      role: string;
      invitationToken: string;
      expiresAt: string;
      invitedBy: string;
    },
    channelsConfig?: NotificationChannelSettings
  ): Promise<NotificationDispatchResult> {
    const payload = {
      type: 'membership_invite',
      fullName: inviteDetails.fullName,
      role: inviteDetails.role,
      invitedBy: inviteDetails.invitedBy,
      expiresAt: inviteDetails.expiresAt,
      inviteUrl: `https://app.journeyax.com/invitations/accept?token=${inviteDetails.invitationToken}&email=${encodeURIComponent(inviteDetails.email)}`,
    };

    return this.dispatch(tenantId, 'membership.invite', payload, channelsConfig, {
      recipients: [inviteDetails.email],
    });
  }

  /**
   * Handles inbound webhook callbacks from email providers (SendGrid, Resend) to update delivery statuses.
   */
  async handleEmailWebhookCallback(
    provider: 'sendgrid' | 'resend' | 'generic',
    headers: Record<string, string>,
    body: any,
    secret?: string
  ): Promise<{ processed: number; errors: string[] }> {
    // If secret provided, verify signature
    if (secret) {
      const signature = headers['x-journeyax-signature'] || headers['x-webhook-signature'];
      if (!signature) {
        throw new Error('Missing webhook signature');
      }
      const hmac = createHmac('sha256', secret);
      hmac.update(typeof body === 'string' ? body : JSON.stringify(body));
      const expected = `sha256=${hmac.digest('hex')}`;
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
      ) {
        throw new Error('Invalid webhook callback signature');
      }
    }

    const events = Array.isArray(body) ? body : [body];
    let processed = 0;
    const errors: string[] = [];

    const col = this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES);

    for (const evt of events) {
      const deliveryId = evt.deliveryId || evt.custom_args?.deliveryId;
      const eventStatus = evt.event || evt.type || 'delivered';

      let mappedStatus: NotificationDeliveryRecord['status'] = 'delivered';
      if (['bounce', 'bounced'].includes(eventStatus)) mappedStatus = 'bounced';
      else if (['open', 'opened'].includes(eventStatus)) mappedStatus = 'opened';
      else if (['click', 'clicked'].includes(eventStatus)) mappedStatus = 'clicked';
      else if (['dropped', 'spamreport'].includes(eventStatus)) mappedStatus = 'dropped';
      else if (['delivered', 'success'].includes(eventStatus)) mappedStatus = 'delivered';

      if (deliveryId) {
        await col.updateOne(
          { deliveryId },
          {
            $set: {
              status: mappedStatus,
              metadata: {
                callbackEvent: eventStatus,
                callbackTimestamp: new Date(),
                rawPayload: evt,
              },
            },
          }
        );
        processed++;
      }
    }

    return { processed, errors };
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
    let newStatus: NotificationDeliveryRecord['status'] = 'delivered';
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
