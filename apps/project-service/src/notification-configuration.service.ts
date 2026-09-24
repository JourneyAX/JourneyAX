import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { ProjectConfig } from './project.types';

export interface NotificationChannelConfig {
  email?: {
    enabled: boolean;
    provider?: 'sendgrid' | 'resend' | 'activepieces' | 'webhook';
    apiKeyRef?: string;
    connectionRef?: string;
    flowId?: string;
    fromEmail?: string;
    fromName?: string;
    defaultRecipients?: string[];
    templateIds?: Record<string, string>;
    rateLimitPerHour?: number;
  };
  webhook?: {
    enabled: boolean;
    url: string;
    secretRef?: string;
    events?: string[];
  };
}

@Injectable()
export class NotificationConfigurationService {
  constructor(
    private getCollection: () => Collection<ProjectConfig>,
    private isConnected: () => boolean,
    private bustCache: (projectId: string) => void
  ) {}

  async getNotificationConfig(projectId: string): Promise<NotificationChannelConfig | null> {
    if (!this.isConnected()) return null;
    const doc = await this.getCollection().findOne(
      { projectId: projectId.toLowerCase() },
      { projection: { 'settings.notifications': 1, notificationChannels: 1 } }
    );
    if (!doc) return null;
    const raw = (doc as any).notificationChannels || (doc as any)?.settings?.notifications || null;
    if (!raw) return null;
    // Sanitize any legacy records to never expose raw secrets
    const sanitized = structuredClone(raw);
    if (sanitized.email) {
      delete (sanitized.email as any).apiKey;
    }
    if (sanitized.webhook) {
      delete (sanitized.webhook as any).secret;
    }
    return sanitized;
  }

  async updateNotificationConfig(
    projectId: string,
    channels: NotificationChannelConfig
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };

    // Strictly reject raw apiKey and secret persistence
    if ((channels?.email as any)?.apiKey || (channels?.webhook as any)?.secret) {
      return {
        success: false,
        message: 'Raw apiKey and secret cannot be persisted in project notification configuration. Use apiKeyRef or secretRef.',
      };
    }

    const pid = projectId.toLowerCase();
    const sanitizedChannels = structuredClone(channels);
    if (sanitizedChannels.email) {
      delete (sanitizedChannels.email as any).apiKey;
    }
    if (sanitizedChannels.webhook) {
      delete (sanitizedChannels.webhook as any).secret;
    }

    const result = await this.getCollection().updateOne(
      { projectId: pid },
      {
        $set: {
          notificationChannels: sanitizedChannels,
          'settings.notifications': sanitizedChannels,
          updatedAt: new Date().toISOString(),
        },
        $inc: { version: 1 },
      }
    );
    if (result.matchedCount === 0) return { success: false, message: `Project '${pid}' not found.` };
    this.bustCache(pid);
    return { success: true };
  }
}
