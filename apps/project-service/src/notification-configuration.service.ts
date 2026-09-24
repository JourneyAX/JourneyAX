import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { ProjectConfig } from './project.types';

export interface NotificationChannelConfig {
  email?: {
    enabled: boolean;
    provider?: 'sendgrid';
    apiKey?: string;
    fromEmail?: string;
    fromName?: string;
    defaultRecipients?: string[];
    templateIds?: Record<string, string>;
  };
  webhook?: {
    enabled: boolean;
    url: string;
    secret?: string;
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
    return (doc as any).notificationChannels || (doc as any)?.settings?.notifications || null;
  }

  async updateNotificationConfig(
    projectId: string,
    channels: NotificationChannelConfig
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const result = await this.getCollection().updateOne(
      { projectId: pid },
      {
        $set: {
          notificationChannels: channels,
          'settings.notifications': channels,
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
