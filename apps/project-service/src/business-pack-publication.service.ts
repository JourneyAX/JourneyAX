import { Injectable } from '@nestjs/common';
import { Db, Collection } from 'mongodb';
import { ProjectConfig, ConfigVersion } from './project.types';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  compileGraphToJourneyDefinition,
} from '@journeyax/business-pack';
import { CapabilityRegistryService, STANDARD_TOOL_SCHEMAS } from './capability-registry.service';

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

    // Ensure journeys conform to JourneyDefinitionSchema
    const validatedJourneys = journeyList.map((j: any) => ({
      journeyId: j.journeyId || `${pid}_journey`,
      version: j.version || '1.0.0',
      displayName: j.displayName || doc.companyName || pid,
      description: j.description || `${doc.companyName || pid} journey flow`,
      goals: Array.isArray(j.goals) && j.goals.length > 0 ? j.goals : ['discovery', 'specification'],
      initialStage: j.initialStage || Object.keys(j.stages || {})[0] || 'discovery',
      stages: j.stages || {},
      metadata: j.metadata || {},
    }));

    // Compile Agents (min 1 required by BusinessPackReleaseSchema)
    const compiledAgents = (doc.agents && Array.isArray(doc.agents) && doc.agents.length > 0)
      ? doc.agents.map((a: any) => ({
          agentId: a.agentId || `${pid}_specialist`,
          name: a.name || `${pid} Specialist`,
          purpose: a.purpose || 'Architectural compliance and product specification',
          systemPromptTemplate: a.systemPromptTemplate || doc.persona?.systemPromptOverrides || `Assist customers with recommendations for ${pid}.`,
          inputSchema: a.inputSchema || {},
          outputSchema: a.outputSchema || {},
          allowedTools: Array.isArray(a.allowedTools) ? a.allowedTools : [],
          modelPolicyRef: a.modelPolicyRef || compiledModelPolicy.defaultPolicy || 'default',
          maxTurns: a.maxTurns || 4,
          handoffConditions: Array.isArray(a.handoffConditions) ? a.handoffConditions : [],
        }))
      : [
          {
            agentId: `${pid}_primary_stylist`,
            name: doc.persona?.systemName || `${pid} Stylist`,
            purpose: 'Primary conversational journey advisor',
            systemPromptTemplate: doc.persona?.systemPromptOverrides || `Assist customers with recommendations for ${pid}.`,
            inputSchema: {},
            outputSchema: {},
            allowedTools: Array.isArray(doc.capabilities) ? doc.capabilities.map((c: any) => typeof c === 'string' ? c : c.toolId) : [],
            modelPolicyRef: compiledModelPolicy.defaultPolicy || 'default',
            maxTurns: 5,
            handoffConditions: [],
          },
        ];

    // Compile Capabilities: toolDefinitions, toolBindings, stageBindings
    const toolNames = new Set<string>();
    if (Array.isArray(doc.capabilities)) {
      doc.capabilities.forEach((c: any) => {
        if (typeof c === 'string') toolNames.add(c);
        else if (c && c.toolId) toolNames.add(c.toolId);
      });
    }
    for (const j of validatedJourneys) {
      if (j.stages && typeof j.stages === 'object') {
        for (const stage of Object.values<any>(j.stages)) {
          if (Array.isArray(stage.allowedCapabilities)) {
            stage.allowedCapabilities.forEach((t: string) => toolNames.add(t));
          }
        }
      }
    }

    const stageBindings: Array<{ journeyId: string; stageId: string; tools: Array<{ toolId: string }> }> = [];
    for (const j of validatedJourneys) {
      if (j.stages && typeof j.stages === 'object') {
        for (const [sId, stage] of Object.entries<any>(j.stages)) {
          stageBindings.push({
            journeyId: j.journeyId,
            stageId: sId,
            tools: (stage.allowedCapabilities || []).map((tId: string) => ({ toolId: tId })),
          });
        }
      }
    }

    const compiledCapabilities = {
      version: '1.0.0',
      toolDefinitions: Array.from(toolNames).map((toolId) => {
        const std = (STANDARD_TOOL_SCHEMAS as any)[toolId] || {};
        return {
          toolId,
          version: '1.0.0',
          displayName: std.displayName || toolId,
          description: std.description || `Capability ${toolId}`,
          inputSchema: std.inputSchema || {},
          outputSchema: std.outputSchema || {},
          sideEffect: std.sideEffect || (toolId.includes('commit') || toolId.includes('create') ? 'transactional' : 'read'),
          risk: std.risk || (toolId.includes('commit') ? 'high' : 'low'),
          timeoutPolicy: { timeoutMs: 10000, retryAttempts: 0 },
          idempotencyPolicy: { required: std.idempotencyRequired || toolId.includes('commit'), ttlSeconds: 86400 },
          approvalPolicy: { requiresApproval: std.requiresApproval || toolId.includes('commit'), ttlMinutes: 60 },
          dataClassification: 'internal' as const,
        };
      }),
      toolBindings: Array.from(toolNames).map((toolId) => ({
        tenantId: pid,
        environmentId: 'production' as const,
        toolId,
        bindingVersion: '1.0.0',
        executor: {
          type: 'native_capability' as const,
          nativeHandler: toolId,
        },
        enabled: true,
        policy: {
          requiredRole: 'customer',
          requiresConfirmation: toolId.includes('commit'),
          idempotencyRequired: toolId.includes('commit'),
          timeoutMs: 10000,
          retryAttempts: 0,
        },
      })),
      stageBindings,
    };

    // Compile Experience (Cards & Themes)
    const themeFromDoc = (doc.uiTheme as any)?.theme || doc.theme;
    const tokens = doc.uiTheme?.tokens;
    const allowedCardTypes = doc.experience?.cards?.allowedCardTypes
      || (doc.cardTemplates ? Object.keys(doc.cardTemplates) : undefined)
      || [
        'bundle',
        'products',
        'productDetail',
        'quote',
        'comparison',
        'plan',
        'cart',
        'orderStatus',
        'guide',
      ];

    const compiledExperience = {
      version: '1.0.0',
      theme: {
        primaryColor: tokens?.colors?.brand || themeFromDoc?.primaryColor || '#0F172A',
        accentColor: tokens?.colors?.accent || themeFromDoc?.accentColor || '#3B82F6',
        fontFamily: tokens?.font?.body || tokens?.font?.display || themeFromDoc?.fontFamily || 'Inter, sans-serif',
        borderRadius: tokens?.radius?.md || themeFromDoc?.borderRadius || '8px',
        customCssVars: (doc.uiTheme as any)?.theme?.customCssVars || {},
      },
      cards: {
        allowedCardTypes,
        defaultCardRenderer: doc.experience?.cards?.defaultCardRenderer || '@journeyax/ui-cards',
        ...(doc.cardTemplates ? { templates: doc.cardTemplates } : {}),
      },
    };

    const compiledEvaluations = Array.isArray(doc.evaluations) && doc.evaluations.length > 0
      ? doc.evaluations
      : Array.isArray((doc as any).scenarios) && (doc as any).scenarios.length > 0
      ? [
          {
            suiteId: `${pid}_acceptance_suite`,
            name: `${doc.companyName || pid} Acceptance Suite`,
            tenantId: pid,
            version: '1.0.0',
            blockingOnPublish: false,
            scenarios: (doc as any).scenarios.map((s: any, idx: number) => ({
              scenarioId: s.id || `scenario_${idx + 1}`,
              name: s.id || `Scenario ${idx + 1}`,
              description: s.say,
              prompt: s.say,
              expectedTargetStage: s.stage,
              assertions: [],
              timeoutMs: 15000,
            })),
          },
        ]
      : [];

    const defaultEntities = doc.business?.entityModel
      ? [
          {
            entityId: doc.business.entityModel.key,
            displayName: doc.business.entityModel.label,
            description: doc.business.entityModel.labelPlural || doc.business.entityModel.label,
            attributes: (doc.business.entityModel.captureFields || []).map((f: any) => ({
              name: f.key,
              type: 'string' as const,
              required: Boolean(f.required),
            })),
          },
        ]
      : [
          {
            entityId: 'customer_context',
            displayName: 'Customer Context',
            description: 'Customer context and preferences',
            attributes: [
              { name: 'budget', type: 'number' as const, required: false },
              { name: 'timeline', type: 'string' as const, required: false },
            ],
          },
        ];

    const businessPack = {
      manifest: {
        packId: `pack_${pid}`,
        tenantId: pid,
        name: doc.companyName || doc.name || pid,
        version: `1.0.${version}`,
        description: `${industry} Business Pack`,
        schemaVersion: '1.0.0',
        environmentId: 'production' as const,
        author: opts.publishedBy || 'studio',
      },
      profile: {
        companyName: doc.companyName || doc.name || pid,
        industry,
        primaryGoals: doc.scope?.categories || ['customer_service'],
        locales: ['en-AU', 'en-US'],
      },
      vocabulary: {
        version: '1.0.0',
        dimensions: dimensions.length > 0 ? dimensions : (doc.vocabulary?.dimensions || []),
        terms: doc.vocabulary?.terms || [],
        acronyms: doc.vocabulary?.acronyms || {},
        slotSynonyms: doc.vocabulary?.slotSynonyms || {},
        slotMappings: doc.vocabulary?.slotMappings || {},
        prohibitedTerms: doc.vocabulary?.prohibitedTerms || [],
      },
      entities: doc.entities || {
        version: '1.0.0',
        entities: defaultEntities,
      },
      conversationPolicy: doc.conversationPolicy || {
        fencingRules: [],
        prohibitedTopics: [],
        escalationThresholds: {
          sentimentFloor: -0.6,
          maxTurnsWithoutProgress: 4,
        },
      },
      modelPolicy: compiledModelPolicy,
      agents: compiledAgents,
      journeys: validatedJourneys,
      rules: Array.isArray(doc.rules) ? doc.rules : [],
      capabilities: compiledCapabilities,
      experience: compiledExperience,
      evaluations: compiledEvaluations,
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
