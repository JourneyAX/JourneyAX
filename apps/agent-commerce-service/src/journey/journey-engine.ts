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
    const journey = release.journeys.find((j) => j.journeyId === workspace.journeyId) || release.journeys[0];
    if (!journey) {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'Journey not found in release' },
        reason: `Journey '${workspace.journeyId}' is not defined in Business Pack '${release.manifest.packId}'`,
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
      // Prioritize optimization or search if we are in build_solution
      if (currentStage.allowedCapabilities.includes('solution.optimize') && workspace.facts['required_item_types']) {
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'invoke_capability',
          targetCapability: 'solution.optimize',
          payload: {
            required_item_types: workspace.facts['required_item_types']?.value,
            occupation: workspace.facts['occupation']?.value,
            budget: workspace.facts['budget']?.value,
          },
          reason: 'All trade requirement facts gathered; optimizing solution bundle.',
          createdAt: new Date().toISOString(),
        };
      }

      const primaryCap = currentStage.allowedCapabilities[0];
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'invoke_capability',
        targetCapability: primaryCap,
        payload: {},
        reason: `Invoking allowed stage capability '${primaryCap}'`,
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
