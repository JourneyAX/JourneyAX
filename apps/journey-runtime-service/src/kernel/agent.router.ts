import { BusinessPackRelease, AgentDefinition } from '@journeyax/business-pack';
import { WorkspaceState } from '@journeyax/journey-core';

export interface ResolvedAgent {
  agent: AgentDefinition;
  systemPrompt: string;
  modelPolicyRef: string;
  allowedTools: string[];
}

export class AgentRouter {
  /**
   * Resolves the primary specialist agent for the current workspace stage.
   */
  resolveAgent(release: BusinessPackRelease, workspace: WorkspaceState): ResolvedAgent {
    const agents = release.agents || [];
    if (agents.length === 0) {
      throw new Error(`Business Pack '${release.manifest.packId}' declares no agents.`);
    }

    const activeJourney = release.journeys.find((j) => j.journeyId === workspace.journeyId);
    const currentStage = activeJourney?.stages[workspace.currentStage];

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
    } else {
      // 2. Direct stage ID match
      const stageMatch = agents.find(
        (a) => a.agentId.toLowerCase() === workspace.currentStage?.toLowerCase()
      );
      if (stageMatch) selectedAgent = stageMatch;
    }

    // 3. Single-agent pack: if exactly one agent is declared, it is the sole specialist
    if (!selectedAgent && agents.length === 1) {
      selectedAgent = agents.find(Boolean);
    }

    if (!selectedAgent) {
      throw new Error(
        `[AgentRouter] Could not resolve specialist agent for stage '${workspace.currentStage}' in journey '${workspace.journeyId}'. Pack declares ${agents.length} agents without an explicit match or targetRole - failing closed.`
      );
    }

    return {
      agent: selectedAgent,
      systemPrompt: selectedAgent.systemPromptTemplate || selectedAgent.purpose,
      modelPolicyRef: selectedAgent.modelPolicyRef,
      allowedTools: selectedAgent.allowedTools || [],
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
