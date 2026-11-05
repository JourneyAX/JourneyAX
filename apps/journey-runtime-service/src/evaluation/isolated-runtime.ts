import { computePackChecksum, getVerifiedBusinessPackMetadata, PackRepository, type BusinessPackRelease } from '@journeyax/business-pack';
import { MemoryActionLedger, type ExecutionContext, type ExecutionResponse, type McpClientProvider } from '@journeyax/capability-sdk';
import type { TurnCommand } from '@journeyax/journey-core';
import type { IqClient } from '@journeyax/jax-iq';
import { TurnApplicationService } from '../kernel/turn-application.service';
import { WorkspaceRepository } from '../kernel/workspace.repository';
import { WorkspaceStore } from '../workspace/workspace.store';
import { JourneyResolver } from '../kernel/journey.resolver';
import { AgentRouter } from '../kernel/agent.router';
import { ModelGateway } from '../kernel/model.gateway';
import { CapabilityGateway } from '../kernel/capability.gateway';
import { ApprovalService } from '../kernel/approval.service';
import { ApprovalStore } from '../approval/approval.store';
import { ExecutionRepository } from '../kernel/execution.repository';
import { OutboxRepository } from '../kernel/outbox.repository';
import { PresentationPort } from '../kernel/presentation.port';
import { OkfKnowledgeControlPlane } from '../kernel/knowledge-control-plane';
import { TurnTranscriptStore } from '../kernel/transcript.store';
import { KnowledgeGapRepository } from '../kernel/knowledge-gap.repository';
import { ProductGuideRepository } from '../kernel/product-guide.repository';
import { ContentPageRepository } from '../kernel/content-page.repository';
import { FormSubmissionRepository } from '../kernel/form-submission.repository';
import { CompanyDirectory } from '../kernel/company-directory';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import { createMongoOkfKnowledgePortResolver } from '../infrastructure/mongo-okf-knowledge.port';

const unavailableIq: IqClient = { query: async () => { throw new Error('Isolated IQ fixtures are not configured for this evaluation.'); } };
const unavailableConnectors: McpClientProvider = { getClient: async () => { throw new Error('Live connectors are unavailable during isolated publication evaluation.'); } };
const localReads = new Set(['catalog.search', 'catalog-search', 'products', 'knowledge.search', 'installGuide']);

/** An evaluation never gains an ambient HTTP/Activepieces/native business-write path from the pack it is checking. */
class EvaluationCapabilities extends CapabilityGateway {
  override async executeCapability(release: BusinessPackRelease, toolId: string, payload: Record<string, any>, ctx: ExecutionContext, options = {}): Promise<ExecutionResponse> {
    const binding = release.capabilities.toolBindings.find(entry => entry.toolId === toolId && entry.enabled !== false && entry.tenantId === ctx.tenantId && entry.environmentId === ctx.environmentId);
    const definition = release.capabilities.toolDefinitions.find(entry => entry.toolId === toolId);
    if (definition?.sideEffect !== 'read' || binding?.executor.type !== 'native_capability' || !localReads.has(binding.executor.nativeHandler || toolId)) {
      return { toolId, status: 'denied', error: 'This isolated answer evaluation permits only its explicit local read ports. No business action or external source call was made.', durationMs: 0, provenance: { executorType: 'policy-gate', executedAt: new Date().toISOString(), correlationId: ctx.correlationId } };
    }
    return super.executeCapability(release, toolId, payload, ctx, options);
  }
}

class UnavailableStock extends BranchStockCheckHandler {
  override async execute() { return { status: 'unavailable', error: 'No inventory fixture was supplied. Availability is unknown, not zero.' }; }
}

/**
 * Reuses the actual agent/harness. Conversation, approvals, transcripts and outbox are private to this one evaluation instance.
 * Catalogue, OKF and documents read only the supplied isolated database. No process environment is changed, no shared catalogue cache
 * is read, and no live source or company directory is inherited. Missing fixtures make assertions fail; they never become made-up data.
 */
export function createIsolatedEvaluationRuntime(release: BusinessPackRelease, isolatedDb: any, ports: { model?: ModelGateway; iqClient?: IqClient } = {}) {
  if (!isolatedDb || typeof isolatedDb.collection !== 'function') throw new Error('An explicit isolated evaluation database is required.');
  if (release.manifest.environmentId !== 'test') throw new Error('Publication evaluation runs only in the isolated test environment.');
  const checksum = getVerifiedBusinessPackMetadata(release)?.checksum ?? computePackChecksum(release);
  const model = ports.model ?? new ModelGateway();
  const knowledge = new OkfKnowledgeControlPlane(async () => isolatedDb);
  const capabilities = new EvaluationCapabilities({ db: isolatedDb, mcpClients: unavailableConnectors, actionLedger: new MemoryActionLedger(), knowledgePortResolver: createMongoOkfKnowledgePortResolver(async () => isolatedDb), secretResolver: { resolve: async () => { throw new Error('Live secrets are unavailable in publication evaluation.'); } } });
  const catalogue = new CatalogSearchHandler(undefined, async () => isolatedDb, undefined, false);
  for (const name of ['catalog.search', 'catalog-search', 'products']) capabilities.registerCustomAdapter(name, catalogue);
  for (const name of ['branch.stock_check', 'checkBranchStock']) capabilities.registerCustomAdapter(name, new UnavailableStock());
  const outbox = new OutboxRepository({ explicitMemory: true });
  const application = new TurnApplicationService(
    new PackRepository(isolatedDb), new WorkspaceRepository(new WorkspaceStore({ explicitMemory: true })), new JourneyResolver(), new AgentRouter(), model, capabilities,
    new ApprovalService(new ApprovalStore({ explicitMemory: true }), outbox), new ExecutionRepository({ explicitMemory: true }), outbox, new PresentationPort(model), knowledge,
    new TurnTranscriptStore({ explicitMemory: true }), new KnowledgeGapRepository(isolatedDb), new ProductGuideRepository(isolatedDb), new ContentPageRepository(isolatedDb), new FormSubmissionRepository(isolatedDb),
    new CompanyDirectory({ baseUrl: () => undefined, headers: async () => ({}) }), {
      iqClient: ports.iqClient ?? unavailableIq,
      commerceStores: { quotes: new Map(), carts: new Map(), products: [] },
    },
  );
  return {
    async executeTurn(command: TurnCommand, candidate: BusinessPackRelease) {
      if (command.tenantId !== release.manifest.tenantId || command.environmentId !== 'test' || computePackChecksum(candidate) !== checksum) throw new Error('Evaluation tenant, environment or candidate checksum changed.');
      if (command.customerEvent || (command as any).customer_event) throw new Error('An answer-quality evaluation cannot approve a business action.');
      return application.executeTurn({ ...command, readOnly: true, proposalTools: [] }, release);
    },
  };
}
