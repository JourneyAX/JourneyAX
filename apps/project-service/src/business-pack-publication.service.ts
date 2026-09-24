import { Injectable } from '@nestjs/common';
import { Db, Collection } from 'mongodb';
import { ProjectConfig, ConfigVersion } from './project.types';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  compileGraphToJourneyDefinition,
} from '@journeyax/business-pack';
import { CapabilityRegistryService } from './capability-registry.service';

@Injectable()
export class BusinessPackPublicationService {
  constructor(
    private getDb: () => Db,
    private getProjectsCol: () => Collection<ProjectConfig>,
    private getVersionsCol: () => Collection<ConfigVersion>,
    private isConnected: () => boolean,
    private bustCache: (projectId: string) => void,
    private getProjectFn: (projectId: string) => Promise<ProjectConfig | null>
  ) {}

  async publishConfig(
    projectId: string,
    opts: { note?: string; publishedBy?: string } = {}
  ): Promise<{ success: boolean; version?: number; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();

    const doc = await this.getProjectsCol().findOne({ projectId: pid });
    if (!doc) return { success: false, message: `Project '${pid}' not found.` };

    // Evaluation Gate (EVAL-001): ensure journey graph has valid entrypoint & compile
    let compiledJourney: any = null;
    const journeyGraph = doc.persona?.journeyGraph;
    if (journeyGraph && Array.isArray(journeyGraph.nodes) && journeyGraph.nodes.length > 0) {
      const hasTrigger = journeyGraph.nodes.some((n: any) => n.data?.kind?.startsWith('trigger.'));
      if (!hasTrigger) {
        return {
          success: false,
          message: 'Publish blocked by evaluation gate: Journey graph must contain at least one Trigger node.',
        };
      }

      const compileRes = compileGraphToJourneyDefinition(
        journeyGraph.nodes,
        journeyGraph.edges || [],
        {
          journeyId: pid,
          displayName: doc.companyName || pid,
        }
      );

      if (!compileRes.success) {
        return {
          success: false,
          message: `Publish blocked by evaluation gate: Journey graph compilation failed: ${(compileRes.errors || []).join('; ')}`,
        };
      }
      compiledJourney = compileRes.journeyDefinition;
    }

    if ((doc as any).evaluationGate?.required && (doc as any).evaluationGate?.passed === false) {
      return {
        success: false,
        message: 'Publish blocked by evaluation gate: Required regression evaluation suite has not passed.',
      };
    }

    const last = await this.getVersionsCol()
      .find({ projectId: pid }).sort({ version: -1 }).limit(1).toArray();
    const version = (last[0]?.version ?? 0) + 1;

    // ── Assemble and publish Immutable Business Pack release into business_pack_releases ──
    const journeyList = compiledJourney
      ? [compiledJourney]
      : Array.isArray(doc.journeys) && doc.journeys.length > 0
      ? doc.journeys
      : doc.persona?.journeyDefinition
      ? (Array.isArray(doc.persona.journeyDefinition) ? doc.persona.journeyDefinition : [doc.persona.journeyDefinition])
      : [];

    if (journeyList.length === 0) {
      return {
        success: false,
        message: 'Publish blocked: Project must define at least one valid journey or compile a journey graph.',
      };
    }

    const industry = doc.business?.type || 'general';
    const dimensions = (doc.contextDimensions || []).map((d: any) => ({
      name: d.key || d.name,
      required: Boolean(d.scoping),
      promptOnMissing: d.question || `What ${d.label || d.key} are you looking for?`,
      allowedValues: d.values || [],
    }));

    let compiledModelPolicy: any = null;
    if (doc.modelPolicy?.policies && Array.isArray(doc.modelPolicy.policies) && doc.modelPolicy.policies.length > 0) {
      compiledModelPolicy = {
        version: doc.modelPolicy.version || '1.0.0',
        defaultPolicy: doc.modelPolicy.defaultPolicy || doc.modelPolicy.policies[0].policyId,
        policies: doc.modelPolicy.policies,
      };
    } else if (doc.ai?.model) {
      const rawProvider = (doc.ai.provider || 'openai').toLowerCase();
      const provider = rawProvider === 'gemini'
        ? 'google'
        : rawProvider === 'ollama'
        ? 'open-model'
        : ['openai', 'anthropic', 'google', 'open-model', 'custom'].includes(rawProvider)
        ? rawProvider
        : 'custom';

      const candidates = [
        {
          provider: provider as any,
          model: doc.ai.model,
          priority: 1,
          temperature: typeof doc.ai.temperature === 'number' ? doc.ai.temperature : undefined,
        },
      ];

      compiledModelPolicy = {
        version: '1.0.0',
        defaultPolicy: 'default',
        policies: [
          {
            policyId: 'default',
            description: `Default model policy for ${pid}`,
            allowedTaskTypes: ['all'],
            candidates,
            timeoutMs: 15000,
            maxRetries: 2,
          },
        ],
      };
    } else {
      return {
        success: false,
        message: 'Publish blocked: Project must define an explicit model policy or AI model configuration.',
      };
    }

    const businessPack = {
      manifest: {
        packId: pid,
        version: `1.0.${version}`,
        schemaVersion: '1.0.0',
        name: doc.name || doc.companyName || pid,
        description: doc.companyName || pid,
        author: opts.publishedBy || 'studio',
        industry,
        status: 'active' as const,
        checksum: '',
      },
      profile: {
        tenantId: pid,
        tenantName: doc.companyName || pid,
        industry,
        supportedLanguages: ['en'],
        defaultLanguage: 'en',
        timezone: (doc as any).regionalSettings?.timezone || 'Australia/Sydney',
        currency: (doc as any).regionalSettings?.currency || 'AUD',
      },
      vocabulary: {
        tenantId: pid,
        industry,
        dimensions,
        termMappings: (doc as any).terminology || {},
      },
      conversationPolicy: {
        tenantId: pid,
        maxTurns: 30,
        groundingRequired: true,
        clarificationThreshold: 0.7,
      },
      modelPolicy: compiledModelPolicy,
      journeys: journeyList,
      capabilities: {
        bindings: Array.isArray(doc.capabilities) ? doc.capabilities : [],
      },
      experience: {
        defaultTheme: (doc.uiTheme as any)?.brandPreset || 'journeyax',
        tokens: doc.uiTheme?.tokens || {},
        cards: doc.cardTemplates || {},
      },
    };

    // Validate Business Pack reference integrity fail-closed
    let availableSecrets: string[] = [];
    try {
      const secretDocs = await this.getDb().collection('tenant_secrets').find({ tenantId: pid }).toArray();
      availableSecrets = secretDocs.map((s: any) => s.secretRef || s.secretKey || s.key || s.name || s.id).filter(Boolean);
    } catch {
      availableSecrets = [];
    }

    const capabilityService = new CapabilityRegistryService();
    const integrity = capabilityService.validateBusinessPackReferenceIntegrity(businessPack as any, {
      availableSecrets,
    });
    if (!integrity.valid) {
      return {
        success: false,
        message: `Publish blocked by reference integrity: ${integrity.errors.join('; ')}`,
      };
    }

    const client = (this.getDb() as any).client;
    const isProduction = process.env.NODE_ENV === 'production';
    const now = new Date().toISOString();

    const executeTransactionalPublish = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      // 1. Publish immutable Business Pack release
      await publishBusinessPack(this.getDb(), businessPack as any, {
        publishedBy: opts.publishedBy || 'studio',
        notes: opts.note || `Studio published version ${version}`,
        session,
      });

      // 2. Snapshot Studio config version
      const snap: ConfigVersion = {
        projectId: pid,
        version,
        publishedAt: now,
        publishedBy: opts.publishedBy || 'system',
        note: opts.note,
        config: { ...doc, version, activeVersion: version, updatedAt: now },
      };
      await this.getVersionsCol().insertOne(snap as any, sessionOpts);

      // 3. Update Studio project activeVersion
      await this.getProjectsCol().updateOne(
        { projectId: pid },
        { $set: { activeVersion: version, updatedAt: now } },
        sessionOpts
      );
    };

    try {
      if (isProduction) {
        if (!client || typeof client.startSession !== 'function') {
          throw new Error('MongoDB client session required for transactional studio publication in production');
        }
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            await executeTransactionalPublish(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        if (client && typeof client.startSession === 'function') {
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              await executeTransactionalPublish(session);
            });
          } catch {
            await executeTransactionalPublish();
          } finally {
            await session.endSession();
          }
        } else {
          await executeTransactionalPublish();
        }
      }
    } catch (pubErr: any) {
      return {
        success: false,
        message: `Publication failed: ${pubErr.message}`,
      };
    }

    this.bustCache(pid);
    return { success: true, version };
  }

  async getPublishedConfig(projectId: string): Promise<(ProjectConfig & { published?: boolean }) | null> {
    const pid = projectId.toLowerCase();
    const draft = await this.getProjectFn(pid);
    if (!draft) return null;
    const active = (draft as any).activeVersion;

    if (!active || !this.isConnected()) {
      if (process.env.NODE_ENV === 'production') {
        return null;
      }
      return { ...draft, published: false };
    }

    try {
      const snap = await this.getVersionsCol().findOne({ projectId: pid, version: active });
      if (snap) return { ...snap.config, published: true };
    } catch {}

    if (process.env.NODE_ENV === 'production') {
      return null;
    }
    return { ...draft, published: false };
  }

  async listVersions(projectId: string): Promise<Array<Omit<ConfigVersion, 'config'> & { active: boolean }>> {
    if (!this.isConnected()) return [];
    const pid = projectId.toLowerCase();
    const draft = await this.getProjectFn(pid);
    const active = (draft as any)?.activeVersion;
    const versions = await this.getVersionsCol()
      .find({ projectId: pid }, { projection: { config: 0, _id: 0 } })
      .sort({ version: -1 }).limit(50).toArray();
    return versions.map((v: any) => ({ ...v, active: v.version === active }));
  }

  async rollbackConfig(
    projectId: string,
    version: number,
    rolledBackBy?: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const snap = await this.getVersionsCol().findOne({ projectId: pid, version });
    if (!snap) return { success: false, message: `Version ${version} not found for '${pid}'.` };

    const targetPackVersion = `1.0.${version}`;
    const client = (this.getDb() as any).client;
    const isProduction = process.env.NODE_ENV === 'production';
    const now = new Date().toISOString();

    const executeTransactionalRollback = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      await rollbackBusinessPack(this.getDb(), pid, 'production', {
        targetVersion: targetPackVersion,
        rolledBackBy: rolledBackBy || 'studio',
        reason: `Studio rollback to version ${version}`,
        session,
      });

      await this.getProjectsCol().updateOne(
        { projectId: pid },
        { $set: { activeVersion: version, updatedAt: now } },
        sessionOpts
      );
    };

    try {
      if (isProduction) {
        if (!client || typeof client.startSession !== 'function') {
          throw new Error('MongoDB client session required for transactional studio rollback in production');
        }
        const session = client.startSession();
        try {
          await session.withTransaction(async () => {
            await executeTransactionalRollback(session);
          });
        } finally {
          await session.endSession();
        }
      } else {
        if (client && typeof client.startSession === 'function') {
          const session = client.startSession();
          try {
            await session.withTransaction(async () => {
              await executeTransactionalRollback(session);
            });
          } catch {
            await executeTransactionalRollback();
          } finally {
            await session.endSession();
          }
        } else {
          await executeTransactionalRollback();
        }
      }
    } catch (rbErr: any) {
      return {
        success: false,
        message: `Rollback failed: ${rbErr.message}`,
      };
    }

    this.bustCache(pid);
    return { success: true };
  }
}
