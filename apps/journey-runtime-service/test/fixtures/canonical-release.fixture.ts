import { BusinessPackContentSchema, computePackChecksum } from '@journeyax/business-pack';
import { rawLegacyFixture } from '../../../../packages/business-pack/test/fixtures/legacy-pack.fixture';

/**
 * Complete canonical Business Pack builders for outbox/worker tests.
 *
 * Releases handed to the OutboxWorker are verified by the authoritative persisted-release verifier,
 * so fixtures must be full BusinessPackContentSchema-valid packs (not `{ capabilities }` fragments).
 */

export interface CanonicalCapabilities {
  toolDefinitions: any[];
  toolBindings: any[];
  stageBindings: any[];
}

export interface CanonicalPackOptions {
  tenantId?: string;
  environmentId?: string;
  version?: string;
  capabilities: CanonicalCapabilities;
  stageIds?: string[];
  journeyId?: string;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

/**
 * Fills the schema-required descriptive fields so call sites can stay terse
 * (`{ toolId, sideEffect, risk }`) while the stored release is still complete and canonical.
 */
export function completeCapabilities(
  caps: CanonicalCapabilities,
  tenantId: string,
  journeyId: string
): CanonicalCapabilities {
  return {
    toolDefinitions: caps.toolDefinitions.map((t) => ({
      displayName: t.toolId,
      name: t.toolId,
      description: `Test tool ${t.toolId}`,
      parameters: {},
      ...t,
    })),
    toolBindings: caps.toolBindings.map((b) => ({ tenantId, ...b })),
    stageBindings: caps.stageBindings.map((s) => ({ journeyId, ...s })),
  };
}

/** Builds complete, schema-valid canonical pack content (what publishBusinessPack would persist). */
export function buildCanonicalPackContent(options: CanonicalPackOptions): any {
  const tenantId = options.tenantId ?? 'tenant_caroma';
  const environmentId = options.environmentId ?? 'production';
  const version = options.version ?? '1.0.0';
  const journeyId = options.journeyId ?? 'journey_outbox_fixture';
  const stageIds = options.stageIds ?? ['stage_sync', 'stage_test', 'stage_restricted'];

  const pack: any = clone(rawLegacyFixture);
  pack.manifest = { ...pack.manifest, tenantId, environmentId, version, packId: `pack_${tenantId}_outbox_fixture` };
  pack.profile = { ...pack.profile, companyName: tenantId };

  const firstStage = stageIds[0];
  pack.journeys = [
    {
      journeyId,
      version: '1.0.0',
      displayName: 'Outbox Fixture Journey',
      goals: ['Exercise governed tool dispatch'],
      initialStage: firstStage,
      stages: Object.fromEntries(
        stageIds.map((stageId) => [
          stageId,
          {
            stageId,
            displayName: stageId,
            requiredFacts: [],
            allowedCapabilities: [],
            nextDecisionPolicy: 'dependency-first',
            exitConditions: [],
          },
        ])
      ),
    },
  ];
  pack.routingPolicy = { defaultJourneyId: journeyId, fallbackOnCatalogSearch: true };

  const caps = completeCapabilities(options.capabilities, tenantId, journeyId);
  pack.capabilities = { version: '1.0.0', ...caps };
  // Agents may only reference tools that this release actually defines (semantic validation).
  const definedToolIds = new Set<string>(caps.toolDefinitions.map((t: any) => t.toolId));
  pack.agents = (pack.agents ?? []).map((agent: any) => ({
    ...agent,
    allowedTools: (agent.allowedTools ?? []).filter((t: string) => definedToolIds.has(t)),
  }));
  return pack;
}

/**
 * Wraps canonical content in a persisted storage envelope (flattened or nested `packData`).
 * Content is stored schema-parsed and the checksum is computed over that parsed content, exactly as
 * publishBusinessPack does. Deliberately schema-invalid content (negative tests) is stored as given.
 */
export function buildStoredRelease(
  content: any,
  options: { shape?: 'flat' | 'nested'; envelope?: Record<string, unknown>; checksum?: string } = {}
): any {
  const parsed = BusinessPackContentSchema.safeParse(content);
  const stored = parsed.success ? (parsed.data as any) : content;
  const envelope = {
    tenantId: stored.manifest.tenantId,
    environmentId: stored.manifest.environmentId,
    version: stored.manifest.version,
    versionId: stored.manifest.version,
    status: 'published',
    checksum: options.checksum ?? computePackChecksum(stored),
    publishedAt: new Date('2026-01-01T00:00:00Z'),
    publishedBy: 'test-fixture',
    ...(options.envelope ?? {}),
  };
  return options.shape === 'nested' ? { ...envelope, packData: stored } : { ...envelope, ...stored };
}
