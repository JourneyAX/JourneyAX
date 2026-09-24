import {
  WorkspaceState,
  Decision,
  JourneyStage,
  findMissingRequiredFacts,
  evaluateStageExit,
} from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export class JourneyResolver {
  /**
   * Resolves the active journey from the Business Pack release.
   */
  resolveJourney(release: BusinessPackRelease, workspace: WorkspaceState) {
    if (workspace.journeyId) {
      const match = release.journeys.find((j) => j.journeyId === workspace.journeyId);
      if (match) return match;
    }
    // Match by customer context or initial trigger if available
    return release.journeys[0] || null;
  }

  /**
   * Evaluates the next canonical state decision:
   * 1. Checks missing required facts first (prevents skipping required stage data).
   * 2. Checks stage exit conditions.
   * 3. Evaluates stage policy (rule-first vs dependency-first).
   * 4. Selects capability or emits conversational response.
   */
  decide(release: BusinessPackRelease, workspace: WorkspaceState): Decision {
    const journey = this.resolveJourney(release, workspace);
    if (!journey) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'No active journey found in release' },
        reason: `Business Pack '${release.manifest.packId}' has no valid journeys configured.`,
        createdAt: new Date().toISOString(),
      };
    }

    const currentStageId = workspace.currentStage || journey.initialStage;
    const currentStage: JourneyStage | undefined = journey.stages[currentStageId];

    if (!currentStage) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'Unknown stage' },
        reason: `Stage '${currentStageId}' does not exist in journey '${journey.journeyId}'`,
        createdAt: new Date().toISOString(),
      };
    }

    // 1. Enforce Required Facts First: Never transition out of a stage with missing required facts
    const missingFacts = findMissingRequiredFacts(currentStage, workspace.facts);
    if (missingFacts.length > 0) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'ask_fact',
        payload: {
          missingFacts,
          stage: currentStageId,
        },
        reason: `Stage '${currentStageId}' requires mandatory facts before advancement: ${missingFacts.join(', ')}`,
        createdAt: new Date().toISOString(),
      };
    }

    // 2. Evaluate stage exit transitions now that required facts are satisfied
    const exitEvaluation = evaluateStageExit(currentStage, workspace.facts);
    if (exitEvaluation.shouldTransition && exitEvaluation.nextStage) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'transition_stage',
        targetStage: exitEvaluation.nextStage,
        payload: {
          fromStage: currentStageId,
          toStage: exitEvaluation.nextStage,
        },
        reason: exitEvaluation.reason || `All required facts present; transitioning to '${exitEvaluation.nextStage}'`,
        createdAt: new Date().toISOString(),
      };
    }

    // 3. Evaluate capability execution in the current stage
    if (currentStage.allowedCapabilities && currentStage.allowedCapabilities.length > 0) {
      // Find candidate capability
      const targetCapability = currentStage.allowedCapabilities[0];

      const factsPayload: Record<string, any> = {};
      for (const [key, fact] of Object.entries(workspace.facts)) {
        if (fact && fact.value !== undefined) {
          factsPayload[key] = fact.value;
        }
      }

      return {
        decisionId: `dec_${Date.now()}`,
        type: 'invoke_capability',
        targetCapability,
        payload: factsPayload,
        reason: `Stage '${currentStageId}' executing allowed capability '${targetCapability}'`,
        createdAt: new Date().toISOString(),
      };
    }

    // 4. Default: Stage requirements satisfied, waiting for user input or goal completed
    return {
      decisionId: `dec_${Date.now()}`,
      type: 'complete_goal',
      payload: { stage: currentStageId },
      reason: `All requirements for stage '${currentStageId}' satisfied.`,
      createdAt: new Date().toISOString(),
    };
  }
}
