import { BusinessPackRelease, AgentDefinition, resolveAccess } from '@journeyax/business-pack';
import { WorkspaceState } from '@journeyax/journey-core';
import type { Principal } from '@journeyax/shared-types';

/** Who is asking, as far as choosing an agent goes. A caller that does not say is treated as a shopper: the least access, never more. */
export type AgentChooser = Pick<Principal, 'audience' | 'groups'>;
const ANONYMOUS_SHOPPER: AgentChooser = { audience: 'shopper', groups: [] };

export interface ResolvedAgent {
  agent: AgentDefinition;
  systemPrompt: string;
  modelPolicyRef: string;
  allowedTools: string[];
  toolFirst?: boolean;
}

export class AgentRouter {
  /**
   * Resolves the primary specialist agent for the current workspace stage.
   *
   * Only agents this person may use are candidates (pack `extensions.agentAccess`, see `resolveAccess`): a locked agent wins, then the agent
   * they asked for (if they may use it), then the agent the table makes their default, then the usual choice by stage and pack default
   * among the agents they may use. A pack without the table lets everyone use every agent, as before.
   */
  resolveAgent(release: BusinessPackRelease, workspace: WorkspaceState, requestedAgentId?: string, principal?: AgentChooser): ResolvedAgent {
    const everyAgent = release.agents || [];
    if (everyAgent.length === 0) {
      throw new Error(`Business Pack '${release.manifest.packId}' declares no agents.`);
    }

    const access = resolveAccess(everyAgent, (release as any)?.extensions?.agentAccess, principal ?? ANONYMOUS_SHOPPER);
    const mayUse = new Set(access.agents.map((entry) => entry.agentId));
    const agents = everyAgent.filter((agent) => mayUse.has(agent.agentId));
    if (agents.length === 0) {
      throw new Error(`[AgentRouter] No agent of pack '${release.manifest.packId}' is available to this ${principal?.audience ?? 'shopper'}; failing closed.`);
    }
    const resolved = (agent: AgentDefinition): ResolvedAgent => ({
      agent,
      systemPrompt: agent.systemPromptTemplate || agent.purpose,
      modelPolicyRef: agent.modelPolicyRef,
      allowedTools: agent.allowedTools || [],
      toolFirst: Boolean((agent as any)?.toolFirst),
    });

    // A locked person has one agent and cannot ask for another.
    if (access.lockedAgentId) return resolved(agents.find((a) => a.agentId === access.lockedAgentId) || agents[0]);

    // The agent the person chose to talk to wins, but only if they may use it; any other id (another tenant's, or a staff agent they may not
    // use) is ignored.
    const chosen = requestedAgentId ? agents.find((a) => a.agentId === requestedAgentId) : undefined;
    if (chosen) return resolved(chosen);

    // The agent the access table opens by default for this person.
    const tableDefault = access.defaultAgentId ? agents.find((a) => a.agentId === access.defaultAgentId) : undefined;
    if (tableDefault) return resolved(tableDefault);

    const activeJourney =
      release.journeys?.find((j) => j.journeyId === workspace?.journeyId) ||
      release.journeys?.find((j) => j.isDefaultConsultant) ||
      release.journeys?.find((j) => j.journeyId === release.routingPolicy?.defaultJourneyId) ||
      (release.journeys?.length === 1 ? release.journeys.find(Boolean) : undefined);

    const currentStageKey = workspace?.currentStage && activeJourney?.stages?.[workspace.currentStage]
      ? workspace.currentStage
      : activeJourney?.initialStage;

    const currentStage = currentStageKey ? activeJourney?.stages?.[currentStageKey] : undefined;

    let selectedAgent: AgentDefinition | undefined;

    // 1. Stage-level handoff policy targetRole match
    if (currentStage?.handoffPolicy?.targetRole) {
      const targetRole = currentStage.handoffPolicy.targetRole.toLowerCase();
      const norm = (s?: string) => (s || '').toLowerCase().replace(/[_\s-]+/g, ' ');
      const normTarget = norm(targetRole);

      const match = agents.find(
        (a) =>
          norm(a.agentId).includes(normTarget) ||
          norm(a.name).includes(normTarget) ||
          norm(a.purpose).includes(normTarget)
      );
      if (match) selectedAgent = match;
    } else if (currentStageKey) {
      // 2. Direct stage ID match
      const stageMatch = agents.find(
        (a) => a.agentId.toLowerCase() === currentStageKey.toLowerCase()
      );
      if (stageMatch) selectedAgent = stageMatch;
    }

    // 3. Single-agent pack: if exactly one agent is declared, it is the sole specialist
    if (!selectedAgent && agents.length === 1) {
      selectedAgent = agents.find(Boolean);
    }

    // 4. Explicit default agent configuration (defaultAgentId or isDefault flag)
    if (!selectedAgent) {
      const explicitDefaultId = (release as any).defaultAgentId || release.routingPolicy?.defaultAgentId;
      if (explicitDefaultId) {
        selectedAgent = agents.find((a) => a.agentId === explicitDefaultId);
      }
      if (!selectedAgent) {
        selectedAgent = agents.find((a) => a.isDefault === true);
      }
    }

    if (!selectedAgent) {
      throw new Error(
        `[AgentRouter] Could not resolve specialist agent for stage '${workspace?.currentStage}' in journey '${workspace?.journeyId}'. Pack declares ${agents.length} agents without an explicit match, targetRole, defaultAgentId, or isDefault flag - failing closed.`
      );
    }

    return {
      agent: selectedAgent,
      systemPrompt: selectedAgent.systemPromptTemplate || selectedAgent.purpose,
      modelPolicyRef: selectedAgent.modelPolicyRef,
      allowedTools: selectedAgent.allowedTools || [],
      toolFirst: Boolean((selectedAgent as any)?.toolFirst),
    };
  }

  /**
   * Composes a structured, token-budgeted prompt for the specialist agent.
   */
  composePrompt(
    resolvedAgent: ResolvedAgent,
    workspace: WorkspaceState,
    userMessage?: string,
    maxContextTokens = 4000
  ): { systemPrompt: string; userPrompt: string } {
    const systemPromptParts = [
      `You are the specialist agent: ${resolvedAgent.agent.name || resolvedAgent.agent.agentId}.`,
      `Purpose: ${resolvedAgent.systemPrompt}`,
      `Authorized Capabilities: ${resolvedAgent.allowedTools.length > 0 ? resolvedAgent.allowedTools.join(', ') : 'None'}.`,
      'Constraints: Rely solely on verified workspace facts and records. Never invent or hallucinate data.',
    ];

    const factsSummary: Record<string, any> = {};
    for (const [k, v] of Object.entries(workspace.facts || {})) {
      factsSummary[k] = {
        value: v.value,
        source: v.source,
      };
    }

    const factsJson = JSON.stringify(factsSummary, null, 2);
    // Truncate facts if excessively long
    const safeFacts = factsJson.length > maxContextTokens * 3
      ? factsJson.slice(0, maxContextTokens * 3) + '\n...[facts truncated for token budget]'
      : factsJson;

    const userPromptParts = [
      `[Workspace Context]`,
      `Tenant: ${workspace.tenantId}`,
      `Journey: ${workspace.journeyId}`,
      `Current Stage: ${workspace.currentStage}`,
      `Journey Goal: ${workspace.goal}`,
      `[Verified Facts]:\n${safeFacts}`,
      `[Open Questions]: ${workspace.openQuestions?.length ? workspace.openQuestions.join(', ') : 'None'}`,
      `[User Message]:\n${userMessage || '(Evaluating workspace progress)'}`,
    ];

    return {
      systemPrompt: systemPromptParts.join('\n\n'),
      userPrompt: userPromptParts.join('\n\n'),
    };
  }
}
