import { randomUUID } from 'node:crypto';
import type { AuthContext } from '../auth/auth.guard';
import type { BusinessPackRelease, OperationalDesk } from '@journeyax/business-pack';
import type { WorkspaceState } from '@journeyax/journey-core';
import { executeAgentTool, type AgentToolContext } from '../agent/agent-tools';
import { confirmCardState, readPending } from '../agent/confirmation';
import { appendHistory } from '../conversation';
import type { ConnectorRuntime } from '../kernel/connector.runtime';
import type { IntakeCase } from './case-intake';

/** A reviewer adopts validated proposals, never the automation identity or its approvals. No LLM or source write runs here. */
export async function materializeCaseReview(input: {
  auth: AuthContext; release: BusinessPackRelease; desk: OperationalDesk;
  assessment: IntakeCase; workspace: WorkspaceState; connectorRuntime: ConnectorRuntime;
}) {
  const { auth, release, desk, assessment, workspace } = input;
  if (assessment.tenantId !== auth.tenantId || assessment.environmentId !== auth.environmentId || assessment.releaseChecksum !== workspace.pins?.packChecksum || workspace.tenantId !== auth.tenantId || workspace.environmentId !== auth.environmentId) throw new Error('Case review scope changed.');
  const ctx = {
    tenantId: auth.tenantId, environmentId: auth.environmentId, principalId: auth.principalId,
    principalRole: auth.principalRole, principal: { audience: 'staff', groups: auth.principalGroups },
    release, workspace, workspaceId: workspace.workspaceId, sessionId: workspace.workspaceId,
    correlationId: randomUUID(), readOnly: true, proposalTools: desk.preparation!.proposalTools,
    connectorRuntime: input.connectorRuntime, presentedCards: [], allowedClaimClasses: new Set(),
    readSourceIds: new Set(), turnProductSkus: new Set(), catalogProductCache: new Map(), isHumanHandoffRequested: false,
  } as AgentToolContext;
  for (const proposal of assessment.proposals ?? []) {
    const result = await executeAgentTool('propose_connector_action', proposal, ctx);
    if (result.status !== 'needs_confirmation') throw new Error('A prepared action is no longer permitted or valid; no change was executed.');
  }
  workspace.facts.case_review = { value: { caseId: assessment._id, deskId: desk.deskId, recordId: assessment.recordId, sourceUpdatedAt: assessment.sourceUpdatedAt, reviewer: auth.principalId, researchedBy: 'automation', summary: assessment.summary }, source: 'system', confidence: 1, extractedAt: new Date().toISOString() };
  appendHistory(workspace, [{ role: 'assistant', content: assessment.summary ?? '', turnId: `case-review:${assessment._id}`, timestamp: new Date().toISOString() }], release.extensions?.dialoguePolicy?.history);
  const pending = readPending(workspace).filter(entry => entry.principalId === auth.principalId && Date.parse(entry.expiresAt) > Date.now());
  return { summary: assessment.summary ?? '', cards: pending.map(entry => ({ cardType: 'confirm', state: confirmCardState(entry) })) };
}
