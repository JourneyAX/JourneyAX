import {
  WorkspaceState,
  Decision,
  JourneyStage,
  JourneyDefinition,
  FactRequirement,
  normalizeFactRequirements,
  findMissingRequiredFacts,
  evaluateStageExit,
  TurnCommand,
} from '@journeyax/journey-core';
import { BusinessPackRelease } from '@journeyax/business-pack';

export type JourneyResolution =
  | { status: 'resolved'; journey: JourneyDefinition }
  | { status: 'ambiguous'; matches: JourneyDefinition[]; reason: string }
  | { status: 'no_match'; reason: string };

export class JourneyResolver {
  /**
   * Resolves the active journey from a Business Pack release.
   * Returns a typed resolution: resolved, ambiguous (multiple equal matches), or no_match.
   * NEVER falls back to journeys[0] blindly.
   */
  resolveJourneyResolution(
    release: BusinessPackRelease,
    workspace: WorkspaceState,
    command?: TurnCommand,
    interpretation?: { intent?: string; candidateFacts?: any }
  ): JourneyResolution {
    if (!release.journeys || release.journeys.length === 0) {
      return { status: 'no_match', reason: 'Release contains no journeys' };
    }

    // 1. If workspace already has a journey pinned, require it to exist in the pack or fail closed
    if (workspace && workspace.journeyId) {
      const match = release.journeys.find((j) => j.journeyId === workspace.journeyId);
      if (match) return { status: 'resolved', journey: match };
      return {
        status: 'no_match',
        reason: `Workspace journey '${workspace.journeyId}' does not exist in pack '${release.manifest.packId}'`,
      };
    }

    // 2. Explicit journeyId in turn command
    const explicitJourneyId = (command as any)?.journeyId || (command as any)?.inputFacts?.journeyId;
    if (explicitJourneyId) {
      const match = release.journeys.find((j) => j.journeyId === explicitJourneyId);
      if (match) return { status: 'resolved', journey: match };
      return {
        status: 'no_match',
        reason: `Explicit command journey '${explicitJourneyId}' does not exist in pack '${release.manifest.packId}'`,
      };
    }

    // 3. Goal/Policy-based semantic matching across journeys using typed interpreted intent
    const targetIntent = interpretation?.intent || (command as any)?.intent;
    const rawMessage = (command?.message || (command as any)?.userInput || '').trim().toLowerCase();
    const matchingJourneys: JourneyDefinition[] = [];

    for (const j of release.journeys) {
      let matched = false;

      // A. Match against explicit journeyId
      if (targetIntent && j.journeyId.toLowerCase() === targetIntent.toLowerCase()) {
        matched = true;
      }

      // B. Match against explicit triggerIntents in pack routing policy or journey metadata
      const triggerIntents: string[] =
        (j as any).triggerIntents ||
        j.metadata?.triggerIntents ||
        j.metadata?.routingPolicy?.intents ||
        [];
      if (targetIntent && triggerIntents.some((ti) => ti.toLowerCase() === targetIntent.toLowerCase())) {
        matched = true;
      }

      // C. Match against journey goals
      if (targetIntent && j.goals.some((g) => g.toLowerCase().includes(targetIntent.toLowerCase()))) {
        matched = true;
      }

      // D. Direct phrase match against triggerIntents or goal keywords from message
      if (!matched && rawMessage.length > 0) {
        if (triggerIntents.some((ti) => rawMessage.includes(ti.toLowerCase()))) {
          matched = true;
        } else {
          // Check keywords in goals, displayName, and journeyId
          const journeyKeywords = new Set<string>();
          for (const g of j.goals) {
            for (const w of g.toLowerCase().split(/[^a-z0-9]+/)) {
              if (w.length > 3) journeyKeywords.add(w);
            }
          }
          if (j.displayName) {
            for (const w of j.displayName.toLowerCase().split(/[^a-z0-9]+/)) {
              if (w.length > 3) journeyKeywords.add(w);
            }
          }
          for (const w of j.journeyId.toLowerCase().split(/[^a-z0-9]+/)) {
            if (w.length > 3) journeyKeywords.add(w);
          }
          for (const s of Object.values(j.stages || {})) {
            for (const cap of s.allowedCapabilities || []) {
              for (const w of cap.toLowerCase().split(/[^a-z0-9]+/)) {
                if (w.length > 3) journeyKeywords.add(w);
              }
            }
          }

          const msgWords = rawMessage.split(/[^a-z0-9]+/).filter((w) => w.length > 3);
          let matchCount = 0;
          for (const mw of msgWords) {
            for (const jw of journeyKeywords) {
              if (
                mw === jw ||
                (mw.length >= 4 && jw.startsWith(mw.slice(0, 4))) ||
                (jw.length >= 4 && mw.startsWith(jw.slice(0, 4)))
              ) {
                matchCount++;
                break;
              }
            }
          }
          if (matchCount >= 1) {
            matched = true;
          }
        }
      }

      if (matched) {
        matchingJourneys.push(j);
      }
    }

    if (matchingJourneys.length === 1) {
      return { status: 'resolved', journey: matchingJourneys[0] };
    }

    if (matchingJourneys.length > 1) {
      return {
        status: 'ambiguous',
        matches: matchingJourneys,
        reason: `Ambiguous match: found ${matchingJourneys.length} matching journeys for intent '${targetIntent || rawMessage}'`,
      };
    }

    return {
      status: 'no_match',
      reason: `No matching journey found in pack '${release.manifest.packId}' for intent '${targetIntent || rawMessage}'`,
    };
  }

  /**
   * Convenience backward-compatible accessor. Returns JourneyDefinition if resolved, or null.
   * NEVER falls back to journeys[0].
   */
  resolveJourney(
    release: BusinessPackRelease,
    workspace: WorkspaceState,
    command?: TurnCommand,
    interpretation?: { intent?: string; candidateFacts?: any }
  ): JourneyDefinition | null {
    const res = this.resolveJourneyResolution(release, workspace, command, interpretation);
    return res.status === 'resolved' ? res.journey : null;
  }

  /**
   * Evaluates the next canonical state decision:
   * 1. Checks structured fact requirements, skips blocked dependencies, asks ONE highest-priority eligible question.
   * 2. Checks stage exit conditions (optional facts do not block).
   * 3. Validates capability inputs against schema with fail-closed checks, never passing unmapped facts.
   */
  decide(
    release: BusinessPackRelease,
    workspace: WorkspaceState,
    command?: TurnCommand,
    interpretation?: { intent?: string; candidateFacts?: any }
  ): Decision {
    const resolution = this.resolveJourneyResolution(release, workspace, command, interpretation);

    if (resolution.status === 'ambiguous') {
      const options = resolution.matches.map((j) => j.displayName || j.journeyId);
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'ask_fact',
        payload: {
          targetFact: 'selected_journey',
          question: `I found multiple matching options for your request. Which service would you like to proceed with?`,
          options,
          multi: false,
          ambiguousMatches: resolution.matches.map((j) => j.journeyId),
        },
        reason: resolution.reason,
        createdAt: new Date().toISOString(),
      };
    }

    if (resolution.status === 'no_match') {
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { error: 'No active journey matched' },
        reason: resolution.reason,
        createdAt: new Date().toISOString(),
      };
    }

    const journey = resolution.journey;
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

    // 1. Enforce Structured Fact Requirements with Priority, Dependencies, and Optional Facts
    const normalizedReqs = normalizeFactRequirements(currentStage.requiredFacts);

    // Filter missing required facts (where value is undefined in workspace.facts)
    const missingReqs = normalizedReqs.filter((r) => {
      const fact = workspace.facts[r.key];
      return fact === undefined || fact.value === undefined || fact.value === null || fact.value === '';
    });

    if (missingReqs.length > 0) {
      // Check dependencies: a requirement is BLOCKED if any of its declared dependencies is missing from workspace.facts
      const eligibleReqs = missingReqs.filter((req) => {
        if (!req.dependencies || req.dependencies.length === 0) return true;
        // All dependencies must be satisfied in workspace.facts
        return req.dependencies.every((depKey) => {
          const depFact = workspace.facts[depKey];
          return depFact !== undefined && depFact.value !== undefined && depFact.value !== null && depFact.value !== '';
        });
      });

      if (eligibleReqs.length === 0) {
        // All missing facts have unsatisfied dependencies! Fail closed.
        const missingDeps = Array.from(new Set(missingReqs.flatMap((r) => r.dependencies || []))).filter(
          (depKey) => workspace.facts[depKey]?.value === undefined
        );
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'fail',
          payload: { error: 'Deadlock: missing requirements have unsatisfied dependencies', missingDependencies: missingDeps },
          reason: `Missing required facts cannot be resolved because prerequisite dependencies are missing: ${missingDeps.join(', ')}`,
          createdAt: new Date().toISOString(),
        };
      }

      // Sort eligible requirements:
      // Primary: Priority descending (e.g. 200 > 100)
      // Secondary: If nextDecisionPolicy === 'dependency-first', prioritize facts that other facts depend on
      eligibleReqs.sort((a, b) => {
        const prioA = a.priority ?? 100;
        const prioB = b.priority ?? 100;
        if (prioB !== prioA) return prioB - prioA;

        if (currentStage.nextDecisionPolicy === 'dependency-first') {
          const isDepA = missingReqs.some((r) => r.dependencies?.includes(a.key));
          const isDepB = missingReqs.some((r) => r.dependencies?.includes(b.key));
          if (isDepA && !isDepB) return -1;
          if (isDepB && !isDepA) return 1;
        }

        return 0;
      });

      // Select EXACTLY ONE highest-priority eligible question
      const targetReq = eligibleReqs[0];
      const targetFact = targetReq.key;

      // Question text and options from structured requirement or vocabulary slotQuestions
      const slotQuestions = (release.vocabulary as any)?.slotQuestions || {};
      const slotDef = slotQuestions[targetFact] || (currentStage as any).questionDefinitions?.[targetFact];

      const entityDef = release.entities?.entities?.find(
        (e: any) => e.entityName === targetFact || e.entityId === targetFact
      );
      const attrDef = entityDef?.attributes?.find((a: any) => a.name === targetFact);
      const options = targetReq.options || slotDef?.options || (entityDef as any)?.allowedValues || attrDef?.enum || [];
      const questionText = targetReq.question || slotDef?.text || `Could you please specify your ${targetFact.replace(/_/g, ' ')}?`;
      const multi = slotDef?.multi || false;

      return {
        decisionId: `dec_${Date.now()}`,
        type: 'ask_fact',
        payload: {
          targetFact,
          missingFacts: missingReqs.map((r) => r.key),
          allMissingFacts: missingReqs.map((r) => r.key),
          stage: currentStageId,
          question: questionText,
          options,
          multi,
          priority: targetReq.priority ?? 100,
          reason: targetReq.reason,
        },
        reason: targetReq.reason || `Stage '${currentStageId}' requires mandatory fact '${targetFact}' before advancement`,
        createdAt: new Date().toISOString(),
      };
    }

    // 2. Evaluate stage exit transitions now that required facts are satisfied
    // (Optional facts do NOT block stage exit)
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

    // 3. Evaluate capability execution in the current stage with strict schema mapping & validation
    if (currentStage.allowedCapabilities && currentStage.allowedCapabilities.length > 0) {
      const targetCapability = currentStage.allowedCapabilities[0];

      // Find tool definition
      const toolDef = release.capabilities?.toolDefinitions?.find((t) => t.toolId === targetCapability);
      if (!toolDef) {
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'fail',
          payload: { error: `Tool definition not found for '${targetCapability}'` },
          reason: `Tool definition '${targetCapability}' not declared in Business Pack`,
          createdAt: new Date().toISOString(),
        };
      }

      // Find stage tool binding if defined
      const stageBinding = release.capabilities?.stageBindings?.find(
        (sb) => sb.journeyId === journey.journeyId && sb.stageId === currentStageId
      );
      const stageTool = stageBinding?.tools?.find((t) => t.toolId === targetCapability);
      const inputMapping: Record<string, string> =
        (stageTool as any)?.inputMapping || (toolDef as any)?.inputMapping || {};

      const inputSchema = toolDef.inputSchema || {};
      const schemaProperties = (inputSchema as any).properties || inputSchema;
      const schemaRequired: string[] = Array.isArray((inputSchema as any).required)
        ? (inputSchema as any).required
        : Object.entries(schemaProperties)
            .filter(([, def]: [string, any]) => def?.required === true)
            .map(([k]) => k);

      const mappedInputs: Record<string, any> = {};

      // 1. Map fields based on declared input schema and explicit mappings ONLY
      for (const [field] of Object.entries(schemaProperties)) {
        const sourceFactKey = inputMapping[field] || field;
        const sourceEntry = workspace.facts[sourceFactKey];
        if (sourceEntry && sourceEntry.value !== undefined && sourceEntry.value !== null) {
          mappedInputs[field] = sourceEntry.value;
        }
      }

      // 2. Validate required inputs — FAIL CLOSED!
      for (const requiredField of schemaRequired) {
        if (mappedInputs[requiredField] === undefined || mappedInputs[requiredField] === null) {
          return {
            decisionId: `dec_${Date.now()}`,
            type: 'fail',
            payload: {
              error: `Missing required capability input '${requiredField}' for '${targetCapability}'`,
              requiredField,
              targetCapability,
            },
            reason: `Capability '${targetCapability}' requires input '${requiredField}', which is missing or unmapped in workspace state`,
            createdAt: new Date().toISOString(),
          };
        }
      }

      // 3. Validate types and enums — FAIL CLOSED!
      for (const [field, val] of Object.entries(mappedInputs)) {
        const fieldDef = (schemaProperties as any)[field];
        if (!fieldDef) continue;

        const expectedType = fieldDef.type;
        if (expectedType) {
          if (expectedType === 'string' && typeof val !== 'string') {
            return {
              decisionId: `dec_${Date.now()}`,
              type: 'fail',
              payload: { error: `Invalid type for input '${field}': expected string, got ${typeof val}` },
              reason: `Input type validation failed for '${field}'`,
              createdAt: new Date().toISOString(),
            };
          }
          if (expectedType === 'number' && typeof val !== 'number') {
            return {
              decisionId: `dec_${Date.now()}`,
              type: 'fail',
              payload: { error: `Invalid type for input '${field}': expected number, got ${typeof val}` },
              reason: `Input type validation failed for '${field}'`,
              createdAt: new Date().toISOString(),
            };
          }
          if (expectedType === 'boolean' && typeof val !== 'boolean') {
            return {
              decisionId: `dec_${Date.now()}`,
              type: 'fail',
              payload: { error: `Invalid type for input '${field}': expected boolean, got ${typeof val}` },
              reason: `Input type validation failed for '${field}'`,
              createdAt: new Date().toISOString(),
            };
          }
        }

        const allowedEnum: string[] = fieldDef.enum || (fieldDef as any).allowedValues;
        if (Array.isArray(allowedEnum) && allowedEnum.length > 0) {
          if (!allowedEnum.includes(val)) {
            return {
              decisionId: `dec_${Date.now()}`,
              type: 'fail',
              payload: { error: `Invalid enum value for input '${field}': '${val}' not in allowed values` },
              reason: `Input enum validation failed for '${field}'`,
              createdAt: new Date().toISOString(),
            };
          }
        }
      }

      // NEVER pass unmapped workspace facts or secrets. Pass ONLY validated mappedInputs.
      return {
        decisionId: `dec_${Date.now()}`,
        type: 'invoke_capability',
        targetCapability,
        payload: mappedInputs,
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
