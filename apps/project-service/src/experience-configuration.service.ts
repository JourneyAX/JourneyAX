import { Injectable } from '@nestjs/common';
import { Db, Collection } from 'mongodb';
import { CardTemplateDoc, CardSpec, ProjectConfig } from './project.types';
import { CARD_TYPE_NAMES, DEFAULT_TEMPLATES, type CardType } from '@journeyax/ui-cards';

@Injectable()
export class ExperienceConfigurationService {
  constructor(
    private getCollection: () => Collection<ProjectConfig>,
    private isConnected: () => boolean,
    private bustCache: (projectId: string) => void,
    private getProjectFn: (projectId: string) => Promise<ProjectConfig | null>
  ) {}

  /** Every card type with the spec the DRAFT currently resolves to. */
  async listCardTemplates(projectId: string): Promise<{
    cards: Array<{
      cardType: CardType;
      source: 'tenant' | 'default';
      spec: CardSpec;
      settings: unknown | null;
      updatedAt?: string;
      updatedBy?: string;
      note?: string;
    }>;
  } | null> {
    const project = await this.getProjectFn(projectId);
    if (!project) return null;
    const overrides = project.cardTemplates || {};
    const cards = CARD_TYPE_NAMES.map((cardType) => {
      const doc = overrides[cardType];
      const settings = project.uiTheme?.cards?.[cardType] ?? null;
      if (doc && doc.spec) {
        return {
          cardType,
          source: 'tenant' as const,
          spec: doc.spec,
          settings,
          updatedAt: doc.updatedAt,
          updatedBy: doc.updatedBy,
          note: doc.note,
        };
      }
      return { cardType, source: 'default' as const, spec: DEFAULT_TEMPLATES[cardType], settings };
    });
    return { cards };
  }

  /** Upsert a tenant override on the draft; bumps `version`. */
  async upsertCardTemplate(
    projectId: string,
    cardType: CardType,
    doc: CardTemplateDoc
  ): Promise<{ success: boolean; message?: string; cardTemplate?: CardTemplateDoc }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const result = await this.getCollection().updateOne(
      { projectId: pid },
      { $set: { [`cardTemplates.${cardType}`]: doc, updatedAt: doc.updatedAt }, $inc: { version: 1 } }
    );
    if (result.matchedCount === 0) return { success: false, message: `Project '${pid}' not found.` };
    this.bustCache(pid);
    return { success: true, cardTemplate: doc };
  }

  /** Remove a tenant override (back to the platform default); bumps `version`. */
  async removeCardTemplate(
    projectId: string,
    cardType: CardType
  ): Promise<{ success: boolean; message?: string; removed?: boolean }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const existing = await this.getCollection().findOne(
      { projectId: pid },
      { projection: { [`cardTemplates.${cardType}`]: 1 } }
    );
    if (!existing) return { success: false, message: `Project '${pid}' not found.` };
    const had = Boolean((existing as any).cardTemplates?.[cardType]);
    if (had) {
      await this.getCollection().updateOne(
        { projectId: pid },
        {
          $unset: { [`cardTemplates.${cardType}`]: '' },
          $set: { updatedAt: new Date().toISOString() },
          $inc: { version: 1 },
        }
      );
      this.bustCache(pid);
    }
    return { success: true, removed: had };
  }
}
