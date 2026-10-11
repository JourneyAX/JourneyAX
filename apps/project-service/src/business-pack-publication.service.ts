import { resolveServiceUrl } from '@journeyax/shared-types';
import { Injectable } from '@nestjs/common';
import { Db, Collection } from 'mongodb';
import { ProjectConfig, ConfigVersion } from './project.types';
import {
  publishBusinessPack,
  rollbackBusinessPack,
  compileGraphToJourneyDefinition,
  compileGraphToJourneys,
  computePackChecksum,
  resolvePublicationRoutingPolicy,
  RoutingPolicyResolutionError,
  BusinessPackLoader,
  ModelPolicySchema,
  compileModelPolicy,
  DEFAULT_PLATFORM_CARD_TYPES,
} from '@journeyax/business-pack';
import { CapabilityRegistryService, STANDARD_TOOL_SCHEMAS } from './capability-registry.service';
import { ReleaseValidationPort } from './release-validation.port';
import { assertOkfReferenceReady, validateOkfJourneyReferences } from '@journeyax/knowledge';
import { UNATTRIBUTED_PRINCIPAL } from '@journeyax/shared-types';

export type PublicationEnvironment = 'dev' | 'test' | 'staging' | 'production';
const PUBLICATION_ENVIRONMENTS: readonly PublicationEnvironment[] = ['dev', 'test', 'staging', 'production'];

/** Resolves the target environment of a publication; production is the default, anything unknown is rejected. */
export function resolvePublicationEnvironment(value?: string | null): PublicationEnvironment {
  const normalized = (value || 'production').trim().toLowerCase();
  if (!PUBLICATION_ENVIRONMENTS.includes(normalized as PublicationEnvironment)) {
    throw new Error(`Invalid environmentId '${value}'. Expected one of: ${PUBLICATION_ENVIRONMENTS.join(', ')}.`);
  }
  return normalized as PublicationEnvironment;
}

export class MissingCatalogueSkuError extends Error {
  constructor(public readonly missingSkus: string[], public readonly tenantId: string) {
    super(`Missing catalogue SKUs in business pack for tenant '${tenantId}': ${missingSkus.join(', ')}`);
    this.name = 'MissingCatalogueSkuError';
  }
}

export class SemanticCategoryMismatchError extends Error {
  constructor(
    public readonly sku: string,
    public readonly componentCategory: string,
    public readonly catalogueCategory: string
  ) {
    super(
      `Semantic category mismatch for SKU '${sku}': component category is '${componentCategory}' but catalogue category is '${catalogueCategory}'`
    );
    this.name = 'SemanticCategoryMismatchError';
  }
}

export function isCategorySemanticallyCompatible(
  componentCategory: string,
  catalogueCategory: string
): boolean {
  const comp = (componentCategory || '').toLowerCase().trim();
  const cat = (catalogueCategory || '').toLowerCase().trim();
  if (!cat) return true;

  switch (comp) {
    case 'lining':
      return (
        cat.includes('plasterboard') ||
        cat.includes('specialist board') ||
        cat.includes('lining') ||
        cat.includes('drywall') ||
        cat.includes('board') ||
        cat.includes('wallboard')
      );

    case 'tub':
    case 'laundry_tub':
      if (cat.includes('specialist board') || cat.includes('plasterboard') || cat.includes('flashing')) {
        return false;
      }
      return (
        cat.includes('tub') ||
        cat.includes('basin') ||
        cat.includes('sink') ||
        cat.includes('laundry cabinetry')
      );

    case 'base':
      if (
        cat.includes('specialist board') ||
        cat.includes('plasterboard') ||
        cat.includes('flashing') ||
        cat.includes('traps & wastes')
      ) {
        return false;
      }
      return (
        cat.includes('vanit') ||
        cat.includes('cabinet') ||
        cat.includes('modular') ||
        cat.includes('base') ||
        cat.includes('drawer') ||
        cat.includes('hardware') ||
        cat.includes('furniture')
      );

    case 'overhead':
      if (
        cat.includes('tapware') ||
        cat.includes('specialist board') ||
        cat.includes('plasterboard') ||
        cat.includes('traps') ||
        cat.includes('tub')
      ) {
        return false;
      }
      return (
        cat.includes('mirror') ||
        cat.includes('vanit') ||
        cat.includes('overhead') ||
        cat.includes('cabinet') ||
        cat.includes('cupboard')
      );

    case 'tall':
      if (
        cat.includes('tapware') ||
        cat.includes('specialist board') ||
        cat.includes('plasterboard') ||
        cat.includes('traps') ||
        cat.includes('scaffold')
      ) {
        return false;
      }
      return (
        cat.includes('tall') ||
        cat.includes('tower') ||
        cat.includes('cupboard') ||
        cat.includes('vanit') ||
        cat.includes('cabinet') ||
        cat.includes('storage') ||
        cat.includes('pantry')
      );

    case 'appliance':
    case 'washer_cavity':
      if (
        cat.includes('specialist board') ||
        cat.includes('plasterboard') ||
        cat.includes('vanit') ||
        cat.includes('traps')
      ) {
        return false;
      }
      return (
        cat.includes('appliance') ||
        cat.includes('washer') ||
        cat.includes('dryer') ||
        cat.includes('dishwasher')
      );

    case 'exterior_barrier':
      if (cat.includes('drywall') || cat.includes('specialist board') || cat.includes('plasterboard')) {
        return false;
      }
      return cat.includes('flashing') || cat.includes('tape') || cat.includes('barrier') || cat.includes('wrap');

    case 'sanitary_plumbing':
      if (cat.includes('specialist board') || cat.includes('plasterboard') || cat.includes('flashing')) {
        return false;
      }
      return cat.includes('trap') || cat.includes('waste') || cat.includes('plumbing') || cat.includes('valve');

    default:
      return true;
  }
}

@Injectable()
export class BusinessPackPublicationService {
  constructor(
    private getDb: () => Db,
    private getProjectsCol: () => Collection<ProjectConfig>,
    private getVersionsCol: () => Collection<ConfigVersion>,
    private isConnected: () => boolean,
    private bustCache: (projectId: string) => void,
    private getProjectFn: (projectId: string) => Promise<ProjectConfig | null>,
    private releaseValidator?: ReleaseValidationPort
  ) {}

  async publishConfig(
    projectId: string,
    opts: { note?: string; publishedBy?: string; environmentId?: string } = {}
  ): Promise<{ success: boolean; version?: number; message?: string; environmentId?: PublicationEnvironment }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    let environmentId: PublicationEnvironment;
    try {
      environmentId = resolvePublicationEnvironment(opts.environmentId);
    } catch (error: any) {
      return { success: false, message: error.message };
    }

    const doc = await this.getProjectsCol().findOne({ projectId: pid });
    if (!doc) return { success: false, message: `Project '${pid}' not found.` };

    // Evaluation Gate (EVAL-001): ensure journey graph has valid entrypoint & compile
    let compiledJourneys: any[] | null = null;
    const journeyGraph = doc.persona?.journeyGraph;
    if (journeyGraph && Array.isArray(journeyGraph.nodes) && journeyGraph.nodes.length > 0) {
      const hasTrigger = journeyGraph.nodes.some((n: any) => n.data?.kind?.startsWith('trigger.'));
      if (!hasTrigger) {
        return {
          success: false,
          message: 'Publish blocked by evaluation gate: Journey graph must contain at least one Trigger node.',
        };
      }

      const compileRes = compileGraphToJourneys(
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
      compiledJourneys = compileRes.journeys || null;
    }

    if ((doc as any).evaluationGate?.required && (doc as any).evaluationGate?.passed === false) {
      return {
        success: false,
        message: 'Publish blocked by evaluation gate: Required regression evaluation suite has not passed.',
      };
    }

    const last = await this.getVersionsCol()
      .find({ projectId: pid }).sort({ version: -1 }).limit(1).toArray();
    const version = Math.max(
      last[0]?.version ?? 0,
      typeof (doc as any).version === 'number' ? (doc as any).version : 0,
      typeof (doc as any).activeVersion === 'number' ? (doc as any).activeVersion : 0
    ) + 1;

    // Resolve next immutable Business Pack release semver, strictly preventing collision with existing immutable releases
    let packReleaseVersion = `1.0.${version}`;
    try {
      const db = this.getDb();
      const existingReleases = await db.collection('business_pack_releases')
        .find({ tenantId: pid })
        .project({ version: 1 })
        .toArray();
      const activePointer = await db.collection('business_pack_pointers')
        .findOne({ tenantId: pid, environmentId });

      const allVersions = new Set<string>();
      for (const r of existingReleases) {
        if (r.version) allVersions.add(String(r.version));
      }
      if (activePointer?.activeVersion) {
        allVersions.add(String(activePointer.activeVersion));
      }

      let highestMajor = 1;
      let highestMinor = 0;
      let highestPatch = version;

      for (const v of allVersions) {
        const parts = v.split('.').map((p) => parseInt(p, 10));
        if (parts.length === 3 && !isNaN(parts[0]) && !isNaN(parts[1]) && !isNaN(parts[2])) {
          if (parts[0] > highestMajor) {
            highestMajor = parts[0];
            highestMinor = parts[1];
            highestPatch = parts[2];
          } else if (parts[0] === highestMajor) {
            if (parts[1] > highestMinor) {
              highestMinor = parts[1];
              highestPatch = parts[2];
            } else if (parts[1] === highestMinor) {
              if (parts[2] > highestPatch) {
                highestPatch = parts[2];
              }
            }
          }
        }
      }

      let candidatePatch = highestPatch + 1;
      let candidate = `${highestMajor}.${highestMinor}.${candidatePatch}`;
      while (allVersions.has(candidate)) {
        candidatePatch++;
        candidate = `${highestMajor}.${highestMinor}.${candidatePatch}`;
      }
      packReleaseVersion = candidate;
    } catch {
      packReleaseVersion = `1.0.${version}`;
    }

    // ── Assemble and publish Immutable Business Pack release into business_pack_releases ──
    const journeyList = (compiledJourneys && compiledJourneys.length > 0)
      ? compiledJourneys
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

    if (!doc.modelPolicy && !doc.ai?.model) {
      return {
        success: false,
        message: 'Publish blocked: Project must define AI model policy or AI model configuration.',
      };
    }

    const compiledModelPolicy = compileModelPolicy({
      projectId: pid,
      mode: doc.modelPolicyMode || (doc.modelPolicy?.isAdvanced ? 'advanced' : 'simple'),
      existingModelPolicy: doc.modelPolicy,
      aiConfig: doc.ai,
      dataResidency: doc.dataResidency || 'au',
    });

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
      ...(typeof j.isDefaultConsultant === 'boolean' ? { isDefaultConsultant: j.isDefaultConsultant } : {}),
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
        environmentId,
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
      || [...DEFAULT_PLATFORM_CARD_TYPES];

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

    // Compile SlotQuestions from vocabulary and dimensions and stage questionDefinitions
    const compiledSlotQuestions: Record<string, any> = {
      ...(doc.vocabulary?.slotQuestions || {}),
    };
    for (const d of dimensions) {
      if (!compiledSlotQuestions[d.name]) {
        compiledSlotQuestions[d.name] = {
          text: d.promptOnMissing || `What ${d.name.replace(/_/g, ' ')} are you looking for?`,
          options: d.allowedValues || [],
        };
      }
    }
    for (const j of validatedJourneys) {
      if (j.stages && typeof j.stages === 'object') {
        for (const stage of Object.values<any>(j.stages)) {
          if (Array.isArray(stage.requiredFacts)) {
            for (const f of stage.requiredFacts) {
              const factKey = typeof f === 'string' ? f : (f.factKey || f.key || f.name);
              if (factKey && !compiledSlotQuestions[factKey]) {
                const qDef = stage.questionDefinitions?.[factKey];
                compiledSlotQuestions[factKey] = {
                  text: qDef?.text || (typeof f === 'object' && f.question) || `What ${factKey.replace(/_/g, ' ')} do you require?`,
                  options: qDef?.options || (typeof f === 'object' && f.options) || [],
                };
              }
            }
          }
        }
      }
    }

    // Default journey is explicit or unambiguous only: no positional ([0]) or tenant-derived guess.
    let resolvedRoutingPolicy;
    try {
      resolvedRoutingPolicy = resolvePublicationRoutingPolicy({
        configured: (doc as any).routingPolicy,
        journeys: validatedJourneys as any[],
      });
    } catch (err: any) {
      if (err instanceof RoutingPolicyResolutionError) {
        return {
          success: false,
          message: `Publish blocked by routing policy: ${err.message}`,
        };
      }
      throw err;
    }

    const businessPack = {
      manifest: {
        packId: `pack_${pid}`,
        tenantId: pid,
        name: doc.companyName || doc.name || pid,
        version: packReleaseVersion,
        description: `${industry} Business Pack`,
        schemaVersion: '1.0.0',
        environmentId,
        author: opts.publishedBy || UNATTRIBUTED_PRINCIPAL,
      },
      profile: {
        companyName: doc.companyName || doc.name || pid,
        industry,
        primaryGoals: doc.scope?.categories || ['customer_service'],
        locales: ['en-AU', 'en-US'],
      },
      routingPolicy: resolvedRoutingPolicy,
      vocabulary: {
        version: '1.0.0',
        dimensions: dimensions.length > 0 ? dimensions : (doc.vocabulary?.dimensions || []),
        terms: doc.vocabulary?.terms || [],
        acronyms: doc.vocabulary?.acronyms || {},
        slotSynonyms: doc.vocabulary?.slotSynonyms || {},
        slotQuestions: compiledSlotQuestions,
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
      ...((doc as any).factRegistry ? { factRegistry: (doc as any).factRegistry } : {}),
      ...((doc as any).knowledgeModel ? { knowledgeModel: (doc as any).knowledgeModel } : {}),
      ...((doc as any).catalogMapping ? { catalogMapping: (doc as any).catalogMapping } : {}),
      modelPolicy: compiledModelPolicy,
      agents: compiledAgents,
      journeys: validatedJourneys,
      rules: Array.isArray(doc.rules) ? doc.rules : [],
      capabilities: compiledCapabilities,
      experience: compiledExperience,
      // Studio compilation has never published evaluation suites in the release content;
      // stated explicitly because the schema no longer injects a default.
      evaluations: [] as any[],
      extensions: (doc as any).extensions || ((doc as any).spacePlanner ? { spacePlanner: (doc as any).spacePlanner } : {}),
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

    // A pack and its structured knowledge are one executable release unit. The
    // reference must resolve before evaluations and is rechecked inside the
    // publication transaction to close the validation-to-publish race.
    if ((businessPack as any).knowledgeModel?.type === 'okf_release') {
      try {
        const okfRelease = await assertOkfReferenceReady(
          this.getDb(),
          (businessPack as any).knowledgeModel,
          { tenantId: pid, environmentId }
        );
        const journeyReferenceIssues = validateOkfJourneyReferences(
          okfRelease.content,
          businessPack.journeys as any
        );
        if (journeyReferenceIssues.length > 0) {
          throw new Error(
            journeyReferenceIssues.map((issue) => `${issue.code}:${issue.message}`).join('; ')
          );
        }
      } catch (error: any) {
        return {
          success: false,
          message: `Publish blocked by OKF reference integrity: ${error.message}`,
        };
      }
    }

    // Validate Space Planner catalogue mappings (verified SKUs and semantic category matching)
    const spacePlannerExt = businessPack.extensions?.spacePlanner;
    if (spacePlannerExt) {
      const plannerIntegrity = await this.validateSpacePlannerCatalogueIntegrity(
        pid,
        spacePlannerExt
      );
      if (!plannerIntegrity.valid) {
        return {
          success: false,
          message: `Publish blocked by space planner catalogue integrity: ${plannerIntegrity.error}`,
        };
      }
    }

    // Publication Gate (PUB-001): Run through injected release-validation port if configured
    let latestEvalSuiteResult: any = null;
    if (this.releaseValidator) {
      const gateResult = await this.releaseValidator.validateRelease(pid, businessPack, packReleaseVersion);
      if (!gateResult.passed) {
        return {
          success: false,
          message: `Publish blocked by publication gate: ${gateResult.error}`,
        };
      }
      latestEvalSuiteResult = gateResult.latestEvalSuiteResult || null;
    }

    const client = (this.getDb() as any).client;
    const isProduction = process.env.NODE_ENV === 'production';
    const now = new Date().toISOString();

    const executeTransactionalPublish = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      if ((businessPack as any).knowledgeModel?.type === 'okf_release') {
        // Deliberately re-read the immutable release at the commit boundary.
        // Revocations remain independent and continue to override pinned workspaces.
        const okfRelease = await assertOkfReferenceReady(
          this.getDb(),
          (businessPack as any).knowledgeModel,
          { tenantId: pid, environmentId },
          session
        );
        const journeyReferenceIssues = validateOkfJourneyReferences(
          okfRelease.content,
          businessPack.journeys as any
        );
        if (journeyReferenceIssues.length > 0) {
          throw new Error(
            `OKF journey references changed or are invalid: ${journeyReferenceIssues
              .map((issue) => `${issue.code}:${issue.message}`)
              .join('; ')}`
          );
        }
      }

      // 1. Publish immutable Business Pack release
      await publishBusinessPack(this.getDb(), {
        ...businessPack,
        evaluationResult: latestEvalSuiteResult,
      } as any, {
        publishedBy: opts.publishedBy || UNATTRIBUTED_PRINCIPAL,
        notes: opts.note || `Studio published version ${packReleaseVersion} (${version})`,
        session,
      });

      // 2. Snapshot Studio config version
      const snap: ConfigVersion = {
        projectId: pid,
        version,
        packVersion: packReleaseVersion,
        publishedAt: now,
        publishedBy: opts.publishedBy || UNATTRIBUTED_PRINCIPAL,
        note: opts.note,
        ...(environmentId === 'production' ? {} : { environmentId }),
        evaluationResult: latestEvalSuiteResult,
        config: {
          ...doc,
          version,
          activeVersion: version,
          packVersion: packReleaseVersion,
          updatedAt: now,
        },
      };
      await this.getVersionsCol().insertOne(snap as any, sessionOpts);

      // 3. Record what is active. Production owns the Studio-wide active version;
      //    other environments are tracked separately so they never disturb it.
      await this.getProjectsCol().updateOne(
        { projectId: pid },
        environmentId === 'production'
          ? { $set: { activeVersion: version, packVersion: packReleaseVersion, updatedAt: now } }
          : { $set: { [`environmentVersions.${environmentId}`]: { version, packVersion: packReleaseVersion, publishedAt: now }, updatedAt: now } },
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
    return { success: true, version, environmentId };
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
    const draft: any = await this.getProjectFn(pid);
    const versions = await this.getVersionsCol()
      .find({ projectId: pid }, { projection: { config: 0, _id: 0 } })
      .sort({ version: -1 }).limit(50).toArray();
    return versions.map((v: any) => {
      const environment = v.environmentId || 'production';
      const activeVersion = environment === 'production' ? draft?.activeVersion : draft?.environmentVersions?.[environment]?.version;
      return { ...v, environmentId: environment, active: v.version === activeVersion };
    });
  }

  async rollbackConfig(
    projectId: string,
    version: number,
    rolledBackBy?: string,
    environmentInput?: string
  ): Promise<{ success: boolean; message?: string; environmentId?: PublicationEnvironment }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    let environmentId: PublicationEnvironment;
    try {
      environmentId = resolvePublicationEnvironment(environmentInput);
    } catch (error: any) {
      return { success: false, message: error.message };
    }
    const snap = await this.getVersionsCol().findOne({ projectId: pid, version });
    if (!snap) return { success: false, message: `Version ${version} not found for '${pid}'.` };
    const snapshotEnvironment = (snap as any).environmentId || 'production';
    if (snapshotEnvironment !== environmentId) {
      return { success: false, message: `Version ${version} was published to '${snapshotEnvironment}', not '${environmentId}'.` };
    }

    const targetPackVersion = (snap as any).packVersion || `1.0.${version}`;
    const client = (this.getDb() as any).client;
    const isProduction = process.env.NODE_ENV === 'production';
    const now = new Date().toISOString();

    const executeTransactionalRollback = async (session?: any) => {
      const sessionOpts = session ? { session } : undefined;

      await rollbackBusinessPack(this.getDb(), pid, environmentId, {
        targetVersion: targetPackVersion,
        rolledBackBy: rolledBackBy || UNATTRIBUTED_PRINCIPAL,
        reason: `Studio rollback to version ${version}`,
        session,
      });

      await this.getProjectsCol().updateOne(
        { projectId: pid },
        environmentId === 'production'
          ? { $set: { activeVersion: version, packVersion: (snap as any).packVersion, updatedAt: now } }
          : { $set: { [`environmentVersions.${environmentId}`]: { version, packVersion: (snap as any).packVersion, publishedAt: now }, updatedAt: now } },
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
    return { success: true, environmentId };
  }

  /**
   * Validates that all SKUs in a space-planner extension exist in the tenant catalogue
   * and that component categories match the catalogue products semantically.
   */
  async validateSpacePlannerCatalogueIntegrity(
    projectId: string,
    spacePlanner: any
  ): Promise<{ valid: boolean; error?: string }> {
    if (!spacePlanner || typeof spacePlanner !== 'object') {
      return { valid: true };
    }

    const pid = projectId.toLowerCase();

    // 1. Gather all SKUs and their required component categories
    const skuCategories = new Map<string, { componentCategory: string; componentId?: string }>();

    if (Array.isArray(spacePlanner.componentReferences)) {
      for (const ref of spacePlanner.componentReferences) {
        if (ref?.sku) {
          skuCategories.set(String(ref.sku).trim(), {
            componentCategory: ref.category || 'base',
            componentId: ref.componentId,
          });
        }
      }
    }

    if (Array.isArray(spacePlanner.roomTypes)) {
      for (const rt of spacePlanner.roomTypes) {
        if (Array.isArray(rt?.defaultComponents)) {
          for (const dc of rt.defaultComponents) {
            if (dc?.sku) {
              const s = String(dc.sku).trim();
              if (!skuCategories.has(s)) {
                skuCategories.set(s, {
                  componentCategory: dc.category || 'base',
                  componentId: dc.componentId,
                });
              }
            }
          }
        }
      }
    }

    if (Array.isArray(spacePlanner.compatibilityClassifications)) {
      for (const cc of spacePlanner.compatibilityClassifications) {
        if (Array.isArray(cc?.skuPatternsOrIds)) {
          for (const rawSku of cc.skuPatternsOrIds) {
            const s = String(rawSku).trim();
            // Validate explicit SKU strings (e.g. numeric IDs)
            if (/^\d{5,10}$/.test(s) && !skuCategories.has(s)) {
              skuCategories.set(s, {
                componentCategory: cc.systemType || 'classification',
                componentId: cc.classificationId,
              });
            }
          }
        }
      }
    }

    const skus = Array.from(skuCategories.keys());
    if (skus.length === 0) {
      return { valid: true };
    }

    // 2. Query tenant product catalogue
    const catalogueMap = new Map<string, { sku: string; category?: string; name?: string }>();

    // Try MongoDB documents/products collections first
    let db: any = null;
    try {
      db = this.getDb ? this.getDb() : null;
    } catch {
      db = null;
    }

    if (db && typeof db.collection === 'function') {
      try {
        const docCol = db.collection('documents');
        if (docCol && typeof docCol.find === 'function') {
          const docs = await docCol
            .find({
              brand: pid,
              'metadata.sku': { $in: skus },
            })
            .toArray();

          for (const d of docs) {
            const sku = String(d.metadata?.sku).trim();
            if (sku && !catalogueMap.has(sku)) {
              catalogueMap.set(sku, {
                sku,
                category: d.metadata?.category || d.category,
                name: d.title || d.name,
              });
            }
          }
        }
      } catch {}

      if (catalogueMap.size < skus.length) {
        try {
          const prodCol = db.collection('products');
          if (prodCol && typeof prodCol.find === 'function') {
            const prods = await prodCol
              .find({
                $or: [
                  { tenantId: pid, sku: { $in: skus } },
                  { brand: pid, sku: { $in: skus } },
                ],
              })
              .toArray();

            for (const p of prods) {
              const sku = String(p.sku).trim();
              if (sku && !catalogueMap.has(sku)) {
                catalogueMap.set(sku, {
                  sku,
                  category: p.category,
                  name: p.name || p.title,
                });
              }
            }
          }
        } catch {}
      }
    }

    // If still missing SKUs, try product-service pricebook via HTTP if internal key available
    const missingFromDb = skus.filter((s) => !catalogueMap.has(s));
    if (missingFromDb.length > 0) {
      const prodServiceUrl = resolveServiceUrl('PRODUCT_SERVICE_URL', process.env.PRODUCT_SERVICE_URL, 'http://localhost:8083');
      const internalKey = process.env.INTERNAL_API_KEY;
      if (internalKey) {
        try {
          const res = await fetch(`${prodServiceUrl}/api/v1/${encodeURIComponent(pid)}/products/pricebook`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Internal-Key': internalKey,
              'X-Tenant-ID': pid,
            },
            body: JSON.stringify({ skus: missingFromDb }),
            signal: AbortSignal.timeout(5000),
          });
          if (res.ok) {
            const data: any = await res.json();
            for (const it of data.items || []) {
              const sku = String(it.sku).trim();
              if (sku) {
                catalogueMap.set(sku, {
                  sku,
                  category: it.category,
                  name: it.name,
                });
              }
            }
          }
        } catch {}
      }
    }

    // 3. Check for missing SKUs
    const missingSkus = skus.filter((s) => !catalogueMap.has(s));
    if (missingSkus.length > 0) {
      const err = new MissingCatalogueSkuError(missingSkus, pid);
      return { valid: false, error: err.message };
    }

    // 4. Check for semantic category mismatches
    for (const [sku, meta] of skuCategories.entries()) {
      const catProduct = catalogueMap.get(sku);
      if (!catProduct || !catProduct.category) continue;

      const compatible = isCategorySemanticallyCompatible(meta.componentCategory, catProduct.category);
      if (!compatible) {
        const err = new SemanticCategoryMismatchError(sku, meta.componentCategory, catProduct.category);
        return { valid: false, error: err.message };
      }
    }

    return { valid: true };
  }
}
