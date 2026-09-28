import {
  JourneyDefinition,
  JourneyStage,
  WorkspaceState,
  Decision,
  evaluateStageExit,
  findMissingRequiredFacts,
  isCapabilityAllowed,
} from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export class JourneyEngine {
  /**
   * Deterministically decides the next action based on the Business Pack definition
   * and the current Workspace State.
   */
  decide(release: BusinessPackRelease, workspace: WorkspaceState): Decision {
    if (!workspace || !workspace.journeyId) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'Missing journeyId' },
        reason: 'Workspace has no active journeyId',
        createdAt: new Date().toISOString(),
      };
    }

    const journey = release.journeys.find((j) => j.journeyId === workspace.journeyId);
    if (!journey) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'Unknown journeyId' },
        reason: `Journey '${workspace.journeyId}' is not defined in Business Pack '${release.manifest.packId}'`,
        createdAt: new Date().toISOString(),
      };
    }

    const currentStageId = workspace.currentStage || journey.initialStage;
    if (!currentStageId) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'Unknown stage' },
        reason: `Journey '${journey.journeyId}' has no initialStage and workspace has no currentStage`,
        createdAt: new Date().toISOString(),
      };
    }

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

    // 1. Check for stage exit transitions (Conditions met to advance)
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
        reason: exitEvaluation.reason || `Transitioning to '${exitEvaluation.nextStage}'`,
        createdAt: new Date().toISOString(),
      };
    }

    // 2. Check for missing required facts for this stage
    const missingFacts = findMissingRequiredFacts(currentStage, workspace.facts);
    if (missingFacts.length > 0) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'ask_fact',
        payload: {
          missingFacts,
          stage: currentStageId,
        },
        reason: `Stage '${currentStageId}' requires facts: ${missingFacts.join(', ')}`,
        createdAt: new Date().toISOString(),
      };
    }

    // 3. Evaluate capability execution in the current stage
    if (currentStage.allowedCapabilities && currentStage.allowedCapabilities.length > 0) {
      const targetCapability = currentStage.allowedCapabilities[0];

      // Assemble generic input payload from verified workspace facts
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
        reason: `Executing stage-allowed capability '${targetCapability}' with verified workspace facts.`,
        createdAt: new Date().toISOString(),
      };
    }

    return {
      decisionId: `dec_${Date.now()}`,
      type: 'complete_goal',
      payload: { goal: workspace.goal },
      reason: 'Stage requirements fulfilled',
      createdAt: new Date().toISOString(),
    };
  }
}
