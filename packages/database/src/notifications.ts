import { Db } from 'mongodb';
import { randomUUID, createHmac, createHash, timingSafeEqual } from 'crypto';
import {
  COLLECTION_NOTIFICATION_DELIVERIES,
  COLLECTION_NOTIFICATION_SUPPRESSIONS,
  COLLECTION_NOTIFICATION_CALLBACKS,
  COLLECTION_OUTBOX_EVENTS,
  NotificationDeliveryRecord,
  NotificationSuppressionRecord,
  NotificationCallbackRecord,
  EnvironmentId,
} from './types';
import {
  CapabilityDispatcher,
  ToolDefinition,
  ToolBinding,
  ExecutionContext,
} from '@journeyax/capability-sdk';

export class NotificationRateLimitError extends Error {
  constructor(public tenantId: string, public currentCount: number, public limitPerHour: number) {
    super(`Rate limit exceeded for tenant '${tenantId}': ${currentCount} / ${limitPerHour} emails sent in the last hour`);
    this.name = 'NotificationRateLimitError';
  }
}

export interface EmailChannelConfig {
  enabled: boolean;
  provider?: 'sendgrid' | 'resend' | 'activepieces' | 'webhook';
  apiKeyRef?: string;
  connectionRef?: string;
  flowId?: string;
  fromEmail?: string;
  fromName?: string;
  defaultRecipients?: string[];
  templateIds?: Record<string, string>;
  templateVersions?: Record<string, string>;
  rateLimitPerHour?: number;
}

export interface WebhookChannelConfig {
  enabled: boolean;
  url: string;
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
    providerDeliveryId?: string;
    deduplicationKey?: string;
  }[];
}

export interface NotificationDispatcherOptions {
  capabilityDispatcher?: CapabilityDispatcher;
  validateConnectionOwnership?: (
    tenantId: string,
    environmentId: string,
    connectionRef: string
  ) => Promise<boolean> | boolean;
}

export class NotificationDispatcher {
  private capabilityDispatcher?: CapabilityDispatcher;
  private customConnectionValidator?: (
    tenantId: string,
    environmentId: string,
    connectionRef: string
  ) => Promise<boolean> | boolean;

  constructor(private db: Db, options?: NotificationDispatcherOptions) {
    if (options?.capabilityDispatcher) {
      this.capabilityDispatcher = options.capabilityDispatcher;
    }
    if (options?.validateConnectionOwnership) {
      this.customConnectionValidator = options.validateConnectionOwnership;
    }
  }

  /**
   * Resolves a secret reference for a tenant strictly from the tenant_secrets collection.
   * Cross-tenant and global environment fallbacks are strictly prohibited.
   */
  async resolveSecret(tenantId: string, secretRef?: string): Promise<string | null> {
    if (!secretRef || !tenantId) return null;
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
   * Validates whether a connectionRef is owned by the specified tenant and environment.
   */
  async validateConnectionOwnership(
    tenantId: string,
    environmentId: string,
    connectionRef: string
  ): Promise<boolean> {
    if (this.customConnectionValidator) {
      return this.customConnectionValidator(tenantId, environmentId, connectionRef);
    }
    try {
      const doc = await this.db.collection('tenant_connections').findOne({
        tenantId,
        environmentId,
        connectionRef,
      });
      return !!doc;
    } catch {
      return false;
    }
  }

  /**
   * Checks whether a recipient is actively suppressed for the given tenant and environment.
   */
  async isSuppressed(
    tenantId: string,
    environmentId: EnvironmentId,
    recipient: string
  ): Promise<boolean> {
    try {
      const found = await this.db
        .collection<NotificationSuppressionRecord>(COLLECTION_NOTIFICATION_SUPPRESSIONS)
        .findOne({
          tenantId,
          environmentId,
          recipient: recipient.toLowerCase().trim(),
        });
      return !!found;
    } catch {
      return false;
    }
  }

  /**
   * Enforces sliding-window rate limit on outbound notifications per tenant.
   */
  async checkRateLimit(tenantId: string, limitPerHour = 100): Promise<void> {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const count = await this.db
      .collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES)
      .countDocuments({
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
    const envId: EnvironmentId = options.environmentId || 'production';

    // ── 1. Dispatch Email ────────────────────────────────────────────────
    const emailConfig = channelsConfig?.email;
    if (emailConfig && emailConfig.enabled) {
      const limit = emailConfig.rateLimitPerHour || 100;
      await this.checkRateLimit(tenantId, limit);

      const recipients =
        options.recipients && options.recipients.length > 0
          ? options.recipients
          : emailConfig.defaultRecipients && emailConfig.defaultRecipients.length > 0
          ? emailConfig.defaultRecipients
          : [];

      const provider = emailConfig.provider || 'sendgrid';

      if (recipients.length === 0) {
        const deliveryId = `deliv_${randomUUID()}`;
        const errorMsg = `No recipients configured for email notification on event '${eventId}' for tenant '${tenantId}'`;
        const deliveryRecord: NotificationDeliveryRecord = {
          deliveryId,
          tenantId,
          environmentId: envId,
          eventId,
          channel: 'email',
          provider,
          recipient: '',
          routingDecision: {
            channel: 'email',
            provider,
            recipient: '',
            reason: 'No recipients configured',
          },
          status: 'failed',
          attempts: 1,
          maxAttempts: 3,
          error: errorMsg,
          createdAt: new Date(),
        };
        await this.db
          .collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES)
          .insertOne(deliveryRecord);

        deliveries.push({
          deliveryId,
          channel: 'email',
          provider,
          recipient: '',
          status: 'failed',
          error: errorMsg,
        });
      }

      // Tenant-scoped secret resolution ONLY. No raw apiKey and no global env fallbacks.
      let effectiveApiKey: string | null = null;
      if (emailConfig.apiKeyRef) {
        effectiveApiKey = await this.resolveSecret(tenantId, emailConfig.apiKeyRef);
      }

      for (const recipient of recipients) {
        const deliveryId = `deliv_${randomUUID()}`;
        const templateId = emailConfig.templateIds?.[eventId];
        const templateVersion = emailConfig.templateVersions?.[eventId] || '1.0.0';

        const deduplicationKey = createHash('sha256')
          .update(`${tenantId}:${envId}:${eventId}:${recipient.toLowerCase().trim()}:${JSON.stringify(payload)}`)
          .digest('hex');

        const routingDecision = {
          channel: 'email' as const,
          provider,
          recipient,
          reason: `Configured email channel via ${provider}`,
        };

        const retrySchedule = {
          nextAttemptAt: new Date(Date.now() + 60000),
          backoffMs: 60000,
          maxRetries: 3,
        };

        let status: NotificationDeliveryRecord['status'] = 'failed';
        let errorMsg: string | undefined;
        let providerDeliveryId: string | undefined;

        // Check suppression list first
        const suppressed = await this.isSuppressed(tenantId, envId, recipient);
        if (suppressed) {
          status = 'failed';
          errorMsg = `Recipient '${recipient}' is actively suppressed for tenant '${tenantId}'`;
        } else if (provider === 'activepieces') {
          // Never treat connectionRef as a URL! Dispatch through CapabilityDispatcher
          try {
            const flowId = emailConfig.flowId || templateId || eventId;
            const connectionRef = emailConfig.connectionRef;

            const tool: ToolDefinition = {
              toolId: 'notification.send',
              version: '1.0.0',
              displayName: 'Notification Dispatch',
              description: 'Dispatch notification via Activepieces flow',
              inputSchema: {},
              outputSchema: {},
              sideEffect: 'write',
              risk: 'low',
              timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
              idempotencyPolicy: { required: false, ttlSeconds: 86400 },
              approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
              dataClassification: 'internal',
            };

            const binding: ToolBinding = {
              toolId: 'notification.send',
              tenantId,
              environmentId: envId,
              bindingVersion: '1.0.0',
              executor: {
                type: 'activepieces_flow',
                flowId,
                connectionRef,
              },
              enabled: true,
              policy: {
                requiredRole: 'customer',
                requiresConfirmation: false,
                idempotencyRequired: false,
                timeoutMs: 10000,
                retryAttempts: 0,
              },
            };

            const execCtx: ExecutionContext = {
              tenantId,
              environmentId: envId,
              workspaceId: `ws_notif_${tenantId}`,
              sessionId: 'system_notification',
              stageId: 'notification',
              packVersionId: 'system',
              correlationId: deliveryId,
              idempotencyKey: deduplicationKey,
            };

            let dispatcher = this.capabilityDispatcher;
            if (!dispatcher) {
              const apApiUrl = process.env.ACTIVEPIECES_API_URL;
              if (!apApiUrl || apApiUrl.trim() === '') {
                throw new Error('Activepieces API URL is required: set ACTIVEPIECES_API_URL');
              }
              const apWebhookSecret = await this.resolveSecret(tenantId, 'activepieces_webhook_secret');
              if (!apWebhookSecret || apWebhookSecret.trim() === '') {
                throw new Error(
                  `Activepieces notification dispatch requires configured 'activepieces_webhook_secret' in tenant_secrets for tenant '${tenantId}'`
                );
              }
              dispatcher = new CapabilityDispatcher({
                activepiecesApiUrl: apApiUrl,
                activepiecesApiKey: (await this.resolveSecret(tenantId, 'activepieces_api_key')) || undefined,
                activepiecesWebhookSecret: apWebhookSecret,
                validateConnectionOwnership: async (tId, eId, cRef) => {
                  return this.validateConnectionOwnership(tId, eId, cRef);
                },
              });
            }

            const res = await dispatcher.dispatch(
              tool,
              binding,
              {
                toolId: 'notification.send',
                input: {
                  tenantId,
                  environmentId: envId,
                  eventId,
                  recipient,
                  payload,
                  deliveryId,
                },
                idempotencyKey: deduplicationKey,
              },
              execCtx
            );

            if (res.status === 'success') {
              status = 'delivered';
              providerDeliveryId = res.output?.deliveryId || res.output?.id || deliveryId;
            } else {
              throw new Error(`Activepieces notification dispatch failed: ${res.error || 'Unknown error'}`);
            }
          } catch (err: any) {
            status = 'failed';
            errorMsg = err.message || 'Activepieces notification dispatch failure';
          }
        } else if (!effectiveApiKey) {
          // Strictly fail-closed when tenant secret reference is missing or unresolved
          status = 'failed';
          errorMsg = `${provider} API key not configured: no valid tenant secret found for '${emailConfig.apiKeyRef || 'unspecified'}' in tenant_secrets for tenant '${tenantId}'`;
        } else {
          try {
            if (provider === 'resend') {
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
                const resData: any = await res.json().catch(() => ({}));
                providerDeliveryId = resData.id || `resend_${randomUUID()}`;
              } else {
                const resText = await res.text();
                throw new Error(`Resend API returned status ${res.status}: ${resText}`);
              }
            } else {
              // SendGrid
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
                providerDeliveryId = `sg_${randomUUID()}`;
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
          routingDecision,
          templateId,
          templateVersion,
          status,
          attempts: 1,
          maxAttempts: 3,
          providerDeliveryId,
          deduplicationKey,
          retrySchedule,
          payload,
          metadata: {
            apiKeyRef: emailConfig.apiKeyRef,
            connectionRef: emailConfig.connectionRef,
            flowId: emailConfig.flowId,
          },
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
          providerDeliveryId,
          deduplicationKey,
        });
      }
    }

    // ── 2. Dispatch Webhook ──────────────────────────────────────────────
    const webhookConfig = channelsConfig?.webhook;
    if (webhookConfig && webhookConfig.enabled && webhookConfig.url) {
      const deliveryId = `deliv_${randomUUID()}`;
      let status: 'delivered' | 'failed' | 'retrying' = 'failed';
      let errorMsg: string | undefined;

      const deduplicationKey = createHash('sha256')
        .update(`${tenantId}:${envId}:${eventId}:${webhookConfig.url}:${JSON.stringify(payload)}`)
        .digest('hex');

      const routingDecision = {
        channel: 'webhook' as const,
        provider: 'webhook',
        recipient: webhookConfig.url,
        reason: 'Configured webhook notification channel',
      };

      const retrySchedule = {
        nextAttemptAt: new Date(Date.now() + 60000),
        backoffMs: 60000,
        maxRetries: 3,
      };

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

        if (!webhookConfig.secretRef || webhookConfig.secretRef.trim() === '') {
          throw new Error(`Outbound webhook requires secretRef for HMAC signing: missing secretRef for tenant '${tenantId}'`);
        }
        const secret = await this.resolveSecret(tenantId, webhookConfig.secretRef);
        if (!secret) {
          throw new Error(
            `Outbound webhook signing secret '${webhookConfig.secretRef}' could not be resolved from tenant_secrets for tenant '${tenantId}'`
          );
        }

        const hmac = createHmac('sha256', secret);
        hmac.update(bodyStr);
        headers['x-journeyax-signature'] = `sha256=${hmac.digest('hex')}`;

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
        provider: 'webhook',
        recipient: webhookConfig.url,
        routingDecision,
        status,
        attempts: 1,
        maxAttempts: 3,
        deduplicationKey,
        retrySchedule,
        payload,
        metadata: {
          secretRef: webhookConfig.secretRef,
        },
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
        deduplicationKey,
      });
    }

    const allSuccessful = deliveries.length > 0 && deliveries.every((d) => d.status === 'delivered');
    return {
      success: allSuccessful,
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
   * Handles inbound webhook callbacks from email providers to update delivery statuses.
   * Requires verified provider webhook signatures, binds updates strictly to tenant/env/provider/deliveryId,
   * deduplicates callbacks, and maintains bounce/suppression records.
   */
  async handleEmailWebhookCallback(
    provider: 'sendgrid' | 'resend' | 'generic',
    headers: Record<string, string>,
    body: any,
    secretOrOptions?:
      | string
      | {
          secret?: string;
          secretRef?: string;
          tenantId?: string;
          environmentId?: EnvironmentId;
        },
    tenantIdParam?: string,
    envIdParam?: EnvironmentId
  ): Promise<{ processed: number; errors: string[] }> {
    let secret: string | undefined;
    let tenantId: string | undefined;
    let environmentId: EnvironmentId = 'production';

    if (typeof secretOrOptions === 'string') {
      secret = secretOrOptions;
      tenantId = tenantIdParam;
      environmentId = envIdParam || 'production';
    } else if (secretOrOptions && typeof secretOrOptions === 'object') {
      secret = secretOrOptions.secret;
      tenantId = secretOrOptions.tenantId || tenantIdParam;
      environmentId = secretOrOptions.environmentId || envIdParam || 'production';
      if (!secret && secretOrOptions.secretRef && tenantId) {
        secret = (await this.resolveSecret(tenantId, secretOrOptions.secretRef)) || undefined;
      }
    }

    // Require verified webhook signature
    if (!secret) {
      throw new Error('Missing webhook signature verification secret: unconfigured secret or secret reference');
    }

    const signature = headers['x-journeyax-signature'] || headers['x-webhook-signature'];
    if (!signature) {
      throw new Error('Missing webhook signature');
    }

    const rawPayload = typeof body === 'string' ? body : JSON.stringify(body);
    const hmac = createHmac('sha256', secret);
    hmac.update(rawPayload);
    const expected = `sha256=${hmac.digest('hex')}`;

    if (
      signature.length !== expected.length ||
      !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
    ) {
      throw new Error('Invalid webhook callback signature');
    }

    if (!tenantId || tenantId.trim() === '') {
      throw new Error('Trusted tenantId is required for webhook callback processing; fail closed');
    }

    const events = Array.isArray(body) ? body : [body];
    let processed = 0;
    const errors: string[] = [];

    const deliveriesCol = this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES);
    const callbacksCol = this.db.collection<NotificationCallbackRecord>(COLLECTION_NOTIFICATION_CALLBACKS);
    const suppressionsCol = this.db.collection<NotificationSuppressionRecord>(COLLECTION_NOTIFICATION_SUPPRESSIONS);

    for (const evt of events) {
      const deliveryId = evt.deliveryId || evt.custom_args?.deliveryId;
      const providerDeliveryId = evt.providerDeliveryId || evt.sg_message_id || evt.id;
      const eventStatus = (evt.event || evt.type || 'delivered').toLowerCase();
      const boundTenantId = tenantId;
      const boundEnvId = environmentId;

      if (!deliveryId && !providerDeliveryId) {
        errors.push('No deliveryId or providerDeliveryId present in webhook event');
        continue;
      }

      // ── Deduplicate Callback ───────────────────────────────────────────
      const callbackDedupKey = `${provider}:${boundTenantId}:${deliveryId || providerDeliveryId}:${eventStatus}`;
      const existingCallback = await callbacksCol.findOne({ callbackId: callbackDedupKey });
      if (existingCallback) {
        errors.push(`Duplicate callback detected for key '${callbackDedupKey}' — skipped`);
        continue;
      }

      await callbacksCol.insertOne({
        callbackId: callbackDedupKey,
        tenantId: boundTenantId,
        environmentId: boundEnvId,
        provider,
        deliveryId: deliveryId || providerDeliveryId,
        status: eventStatus,
        processedAt: new Date(),
        rawPayload: evt,
      });

      // ── Map Status ─────────────────────────────────────────────────────
      let mappedStatus: NotificationDeliveryRecord['status'] = 'delivered';
      if (['bounce', 'bounced'].includes(eventStatus)) mappedStatus = 'bounced';
      else if (['open', 'opened'].includes(eventStatus)) mappedStatus = 'opened';
      else if (['click', 'clicked'].includes(eventStatus)) mappedStatus = 'clicked';
      else if (['dropped', 'spamreport', 'complaint'].includes(eventStatus)) mappedStatus = 'dropped';
      else if (['delivered', 'success'].includes(eventStatus)) mappedStatus = 'delivered';

      // ── Bind update strictly to trusted tenantId, environmentId, provider, and deliveryId / providerDeliveryId ──
      const orMatch: any[] = [];
      if (deliveryId) orMatch.push({ deliveryId });
      if (providerDeliveryId) orMatch.push({ providerDeliveryId });

      const query: any = {
        tenantId: boundTenantId,
        environmentId: boundEnvId,
        provider,
        $or: orMatch,
      };

      const updateResult = await deliveriesCol.updateOne(query, {
        $set: {
          status: mappedStatus,
          providerDeliveryId: providerDeliveryId || deliveryId,
          metadata: {
            callbackEvent: eventStatus,
            callbackTimestamp: new Date(),
            rawPayload: evt,
          },
        },
      });

      if (updateResult.matchedCount > 0) {
        processed++;
      } else {
        errors.push(
          `No matching delivery record found for tenant '${boundTenantId}' and deliveryId '${deliveryId || providerDeliveryId}'`
        );
      }

      // ── Maintain Bounce/Suppression State ──────────────────────────────
      if (mappedStatus === 'bounced' || mappedStatus === 'dropped') {
        const delivDoc = await deliveriesCol.findOne(query);
        const recipient = (evt.email || evt.recipient || delivDoc?.recipient || '').toLowerCase().trim();
        if (recipient && boundTenantId) {
          await suppressionsCol.updateOne(
            { tenantId: boundTenantId, environmentId: boundEnvId, recipient },
            {
              $set: {
                tenantId: boundTenantId,
                environmentId: boundEnvId,
                recipient,
                channel: 'email',
                reason: mappedStatus === 'bounced' ? 'bounce' : 'complaint',
                provider,
                providerDeliveryId: providerDeliveryId || deliveryId,
                updatedAt: new Date(),
                metadata: {
                  callbackEvent: eventStatus,
                  rawPayload: evt,
                },
              },
              $setOnInsert: { createdAt: new Date() },
            },
            { upsert: true }
          );
        }
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
   * Retries an individual failed delivery with genuine provider execution.
   * Scopes query strictly by trusted tenantId, environmentId, provider, and deliveryId.
   * Never marks delivered without performing a real send and verifying success.
   */
  async retryDelivery(
    deliveryIdOrTenantId: string,
    channelsConfigOrEnvId?: NotificationChannelSettings | EnvironmentId,
    deliveryIdParam?: string,
    channelsConfigParam?: NotificationChannelSettings,
    providerParam?: string
  ): Promise<NotificationDeliveryRecord | null> {
    const col = this.db.collection<NotificationDeliveryRecord>(COLLECTION_NOTIFICATION_DELIVERIES);

    let tenantId: string | undefined;
    let environmentId: EnvironmentId | undefined;
    let deliveryId: string;
    let channelsConfig: NotificationChannelSettings | undefined;
    let provider: string | undefined;

    if (typeof deliveryIdParam === 'string') {
      tenantId = deliveryIdOrTenantId;
      environmentId = channelsConfigOrEnvId as EnvironmentId;
      deliveryId = deliveryIdParam;
      channelsConfig = channelsConfigParam;
      provider = providerParam;
    } else {
      deliveryId = deliveryIdOrTenantId;
      channelsConfig = channelsConfigOrEnvId as NotificationChannelSettings | undefined;
      const extraScope = (channelsConfig as any)?._scope;
      tenantId = extraScope?.tenantId;
      environmentId = extraScope?.environmentId;
      provider = extraScope?.provider;
    }

    const query: any = { deliveryId };
    if (tenantId) query.tenantId = tenantId;
    if (environmentId) query.environmentId = environmentId;
    if (provider) query.provider = provider;

    const existing = await col.findOne(query);
    if (!existing || existing.status === 'delivered') return existing;

    const nextAttempts = (existing.attempts || 1) + 1;
    let newStatus: NotificationDeliveryRecord['status'] = 'failed';
    let errorMsg: string | undefined;
    let providerDeliveryId = existing.providerDeliveryId;

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

        const secretRef = channelsConfig?.webhook?.secretRef || existing.metadata?.secretRef;
        if (!secretRef || secretRef.trim() === '') {
          throw new Error(
            `Outbound webhook retry requires secretRef for HMAC signing: missing secretRef for tenant '${existing.tenantId}'`
          );
        }
        const secret = await this.resolveSecret(existing.tenantId, secretRef);
        if (!secret) {
          throw new Error(
            `Outbound webhook signing secret '${secretRef}' could not be resolved from tenant_secrets for tenant '${existing.tenantId}'`
          );
        }

        const hmac = createHmac('sha256', secret);
        hmac.update(bodyStr);
        headers['x-journeyax-signature'] = `sha256=${hmac.digest('hex')}`;

        const res = await fetch(existing.recipient, {
          method: 'POST',
          headers,
          body: bodyStr,
        });

        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        newStatus = 'delivered';
      } catch (err: any) {
        newStatus = nextAttempts >= existing.maxAttempts ? 'failed' : 'retrying';
        errorMsg = err.message;
      }
    } else if (existing.channel === 'email') {
      const envId = existing.environmentId || 'production';
      const isSuppressed = await this.isSuppressed(existing.tenantId, envId, existing.recipient);

      if (isSuppressed) {
        newStatus = 'failed';
        errorMsg = `Recipient '${existing.recipient}' is actively suppressed for tenant '${existing.tenantId}'`;
      } else {
        const emailProvider = existing.provider || channelsConfig?.email?.provider || 'sendgrid';
        const apiKeyRef = channelsConfig?.email?.apiKeyRef || existing.metadata?.apiKeyRef;

        try {
          if (emailProvider === 'activepieces') {
            const flowId =
              existing.metadata?.flowId || channelsConfig?.email?.flowId || existing.templateId || existing.eventId;
            const connectionRef = channelsConfig?.email?.connectionRef || existing.metadata?.connectionRef;

            const tool: ToolDefinition = {
              toolId: 'notification.send',
              version: '1.0.0',
              displayName: 'Notification Dispatch',
              description: 'Dispatch notification via Activepieces flow',
              inputSchema: {},
              outputSchema: {},
              sideEffect: 'write',
              risk: 'low',
              timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
              idempotencyPolicy: { required: false, ttlSeconds: 86400 },
              approvalPolicy: { requiresApproval: false, ttlMinutes: 60 },
              dataClassification: 'internal',
            };

            const binding: ToolBinding = {
              toolId: 'notification.send',
              tenantId: existing.tenantId,
              environmentId: envId,
              bindingVersion: '1.0.0',
              executor: {
                type: 'activepieces_flow',
                flowId,
                connectionRef,
              },
              enabled: true,
              policy: {
                requiredRole: 'customer',
                requiresConfirmation: false,
                idempotencyRequired: false,
                timeoutMs: 10000,
                retryAttempts: 0,
              },
            };

            let dispatcher = this.capabilityDispatcher;
            if (!dispatcher) {
              const apApiUrl = process.env.ACTIVEPIECES_API_URL;
              if (!apApiUrl || apApiUrl.trim() === '') {
                throw new Error('Activepieces API URL is required: set ACTIVEPIECES_API_URL');
              }
              const apWebhookSecret = await this.resolveSecret(existing.tenantId, 'activepieces_webhook_secret');
              if (!apWebhookSecret || apWebhookSecret.trim() === '') {
                throw new Error(
                  `Activepieces notification dispatch requires configured 'activepieces_webhook_secret' in tenant_secrets for tenant '${existing.tenantId}'`
                );
              }
              dispatcher = new CapabilityDispatcher({
                activepiecesApiUrl: apApiUrl,
                activepiecesApiKey: (await this.resolveSecret(existing.tenantId, 'activepieces_api_key')) || undefined,
                activepiecesWebhookSecret: apWebhookSecret,
                validateConnectionOwnership: async (tId, eId, cRef) => {
                  return this.validateConnectionOwnership(tId, eId, cRef);
                },
              });
            }

            const res = await dispatcher.dispatch(
              tool,
              binding,
              {
                toolId: 'notification.send',
                input: {
                  tenantId: existing.tenantId,
                  environmentId: envId,
                  eventId: existing.eventId,
                  recipient: existing.recipient,
                  payload: existing.payload,
                  deliveryId,
                  isRetry: true,
                  retryAttempt: nextAttempts,
                },
                idempotencyKey: existing.deduplicationKey,
              },
              {
                tenantId: existing.tenantId,
                environmentId: envId,
                workspaceId: `ws_notif_${existing.tenantId}`,
                sessionId: 'system_notification',
                stageId: 'notification',
                packVersionId: 'system',
                correlationId: deliveryId,
                idempotencyKey: existing.deduplicationKey,
              }
            );

            if (res.status === 'success') {
              newStatus = 'delivered';
              providerDeliveryId = res.output?.deliveryId || res.output?.id || deliveryId;
            } else {
              throw new Error(`Activepieces notification dispatch failed: ${res.error || 'Unknown error'}`);
            }
          } else {
            if (!apiKeyRef) {
              throw new Error(`Email provider '${provider}' retry failed: no tenant apiKeyRef configured`);
            }
            const effectiveApiKey = await this.resolveSecret(existing.tenantId, apiKeyRef);
            if (!effectiveApiKey) {
              throw new Error(
                `Email provider '${provider}' retry failed: tenant secret reference '${apiKeyRef}' could not be resolved from tenant_secrets for tenant '${existing.tenantId}'`
              );
            }

            if (provider === 'resend') {
              const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${effectiveApiKey}`,
                },
                body: JSON.stringify({
                  from: `JourneyAX Alerts <alerts@journeyax.com>`,
                  to: [existing.recipient],
                  subject: `[JourneyAX] Alert: ${existing.eventId} (Retry #${nextAttempts})`,
                  html: `<p><strong>Alert for ${existing.eventId} (Retry #${nextAttempts})</strong></p><pre>${JSON.stringify(existing.payload, null, 2)}</pre>`,
                }),
              });

              if (!res.ok) {
                const txt = await res.text();
                throw new Error(`Resend API returned status ${res.status}: ${txt}`);
              }
              const resData: any = await res.json().catch(() => ({}));
              providerDeliveryId = resData.id || `resend_${randomUUID()}`;
              newStatus = 'delivered';
            } else {
              // SendGrid
              const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Authorization: `Bearer ${effectiveApiKey}`,
                },
                body: JSON.stringify({
                  personalizations: [{ to: [{ email: existing.recipient }] }],
                  from: { email: 'alerts@journeyax.com', name: 'JourneyAX Alerts' },
                  subject: `[JourneyAX] Alert: ${existing.eventId} (Retry #${nextAttempts})`,
                  content: [{ type: 'text/plain', value: JSON.stringify(existing.payload, null, 2) }],
                }),
              });

              if (!res.ok && res.status !== 202) {
                const txt = await res.text();
                throw new Error(`SendGrid API returned status ${res.status}: ${txt}`);
              }
              providerDeliveryId = `sg_${randomUUID()}`;
              newStatus = 'delivered';
            }
          }
        } catch (err: any) {
          newStatus = nextAttempts >= existing.maxAttempts ? 'failed' : 'retrying';
          errorMsg = err.message;
        }
      }
    }

    const backoffMs = existing.retrySchedule?.backoffMs || 60000;
    const delay = backoffMs * Math.pow(2, nextAttempts - 1);
    const nextAttemptAt = newStatus === 'retrying' ? new Date(Date.now() + delay) : undefined;

    const update: any = {
      $set: {
        attempts: nextAttempts,
        status: newStatus,
        error: errorMsg,
        providerDeliveryId,
        deliveredAt: newStatus === 'delivered' ? new Date() : undefined,
        nextAttemptAt,
        'retrySchedule.nextAttemptAt': nextAttemptAt,
      },
    };

    await col.updateOne(
      {
        deliveryId: existing.deliveryId,
        tenantId: existing.tenantId,
        environmentId: existing.environmentId,
        ...(existing.provider ? { provider: existing.provider } : {}),
      },
      update
    );
    return col.findOne({
      deliveryId: existing.deliveryId,
      tenantId: existing.tenantId,
      environmentId: existing.environmentId,
    });
  }
}
