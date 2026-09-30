import {
  WorkspaceState,
  Decision,
  JourneyStage,
  JourneyDefinition,
  FactRequirement,
  normalizeFactRequirements,
  findMissingRequiredFacts,
  evaluateStageExit,
  evaluateControlledExpression,
  areAllFactsPresent,
  areAnyFactsPresent,
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

    const rawMessage = (command?.message || (command as any)?.userInput || '').trim().toLowerCase();
    const targetIntent = (interpretation?.intent || (command as any)?.intent || '').trim();

    // Check if user answered selected_journey fact
    const selectedJourneyFact =
      workspace?.facts?.['selected_journey']?.value ||
      interpretation?.candidateFacts?.['selected_journey']?.value ||
      (command as any)?.inputFacts?.selected_journey;
    if (selectedJourneyFact) {
      const match = release.journeys.find(
        (j) =>
          j.journeyId === selectedJourneyFact ||
          j.displayName === selectedJourneyFact ||
          j.journeyId.toLowerCase() === String(selectedJourneyFact).toLowerCase() ||
          (j.displayName && j.displayName.toLowerCase() === String(selectedJourneyFact).toLowerCase())
      );
      if (match) return { status: 'resolved', journey: match };
    }

    // 1. Check for intentional journey switch if workspace already has a pinned journey
    // (a pack-declared switch policy allows customer to explicitly switch journeys)
    if (workspace && workspace.journeyId && workspace.journeyId !== 'unassigned') {
      const allowSwitch =
        (release.conversationPolicy as any)?.allowJourneySwitch !== false;

      if (allowSwitch && rawMessage.length > 0) {
        // Check if customer explicitly requested another journey
        const otherJourneys = release.journeys.filter((j) => j.journeyId !== workspace.journeyId);
        for (const other of otherJourneys) {
          const switchRequested =
            (other.displayName && rawMessage.includes(other.displayName.toLowerCase())) ||
            rawMessage.includes(other.journeyId.toLowerCase()) ||
            (rawMessage.includes('switch') && other.goals.some((g) => rawMessage.includes(g.toLowerCase())));
          if (switchRequested) {
            return { status: 'resolved', journey: other };
          }
        }
      }

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

    // 3. Goal/Policy-based semantic matching using pack-declared triggerIntents, goal phrases, and interpreter intent
    // (Drop capability-name keywords and prefix fuzzing. Score matches and resolve when top score beats runner-up by a margin.)
    const scoredJourneys: { journey: JourneyDefinition; score: number }[] = [];

    for (const j of release.journeys) {
      let score = 0;

      // A. Match against explicit journeyId
      if (targetIntent && j.journeyId.toLowerCase() === targetIntent.toLowerCase()) {
        score += 100;
      }

      // B. Match against explicit triggerIntents in pack routing policy or journey metadata
      const triggerIntents: string[] =
        (j as any).triggerIntents ||
        j.metadata?.triggerIntents ||
        j.metadata?.routingPolicy?.intents ||
        [];
      if (targetIntent && triggerIntents.some((ti) => ti.toLowerCase() === targetIntent.toLowerCase())) {
        score += 80;
      }

      // C. Match against journey goals
      if (targetIntent && Array.isArray(j.goals) && j.goals.some((g) => g.toLowerCase().includes(targetIntent.toLowerCase()))) {
        score += 40;
      }

      // D. Direct phrase match against triggerIntents or goal phrases from customer message
      if (rawMessage.length > 0) {
        for (const ti of triggerIntents) {
          const lowerTi = ti.toLowerCase();
          if (rawMessage === lowerTi) {
            score += 70;
          } else if (rawMessage.includes(lowerTi)) {
            score += 50;
          }
        }

        for (const g of j.goals) {
          const lowerG = g.toLowerCase();
          if (rawMessage.includes(lowerG)) {
            score += 40;
          }
        }

        if (j.displayName && rawMessage.includes(j.displayName.toLowerCase())) {
          score += 50;
        }

        // Token match on pack-declared goals, displayName, and journeyId (NO capability names! NO 4-char prefix fuzzing!)
        const msgTokens = rawMessage.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
        const goalTokens = new Set<string>();
        for (const g of j.goals) {
          for (const t of g.toLowerCase().split(/[^a-z0-9]+/)) {
            if (t.length > 2) goalTokens.add(t);
          }
        }
        if (j.displayName) {
          for (const t of j.displayName.toLowerCase().split(/[^a-z0-9]+/)) {
            if (t.length > 2) goalTokens.add(t);
          }
        }
        for (const t of j.journeyId.toLowerCase().split(/[^a-z0-9]+/)) {
          if (t.length > 2) goalTokens.add(t);
        }
        for (const mt of msgTokens) {
          for (const gt of goalTokens) {
            if (mt === gt || (mt.length >= 4 && gt.startsWith(mt)) || (gt.length >= 4 && mt.startsWith(gt))) {
              score += 10;
              break;
            }
          }
        }
      }

      if (score > 0) {
        scoredJourneys.push({ journey: j, score });
      }
    }

    scoredJourneys.sort((a, b) => b.score - a.score);

    if (scoredJourneys.length === 1 && scoredJourneys[0].score >= 10) {
      return { status: 'resolved', journey: scoredJourneys[0].journey };
    }

    if (scoredJourneys.length > 1) {
      const top = scoredJourneys[0];
      const runnerUp = scoredJourneys[1];
      // Resolve when top score beats runner-up by a clear margin
      if (top.score >= runnerUp.score + 20 && top.score >= 30) {
        return { status: 'resolved', journey: top.journey };
      }
      return {
        status: 'ambiguous',
        matches: scoredJourneys.map((s) => s.journey),
        reason: `Ambiguous match: multiple matching journeys for intent '${targetIntent || rawMessage}' (scores: ${scoredJourneys.map((s) => `${s.journey.journeyId}=${s.score}`).join(', ')})`,
      };
    }

    // Check if greeting or empty:
    const isGreeting = ['hi', 'hello', 'hey', 'kia ora', 'good morning', 'good afternoon', 'good evening', 'help'].includes(rawMessage);
    return {
      status: 'no_match',
      reason: isGreeting ? 'greeting' : `No matching journey found in pack '${release.manifest.packId}' for intent '${targetIntent || rawMessage}'`,
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
   * 1. Checks stage handoffPolicy and rule-first policy.
   * 2. Checks structured fact requirements, skips blocked dependencies, asks ONE highest-priority eligible question.
   * 3. Checks stage exit conditions (conditionRuleRef evaluated against release.rules).
   * 4. Evaluates capability execution via capabilityPlan or allowedCapabilities, advancing when outputs are present.
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
      if (resolution.reason === 'greeting' || !command?.message) {
        const welcomeMessage =
          (release as any).experience?.welcomeMessage ||
          (release.vocabulary as any)?.welcomeMessage ||
          `Welcome to ${release.profile?.companyName || 'our services'}. How can we assist you with your project today?`;
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'ask_fact',
          payload: {
            targetFact: 'selected_journey',
            question: welcomeMessage,
            options: release.journeys.map((j) => j.displayName || j.journeyId),
          },
          reason: 'Greeting received; presenting welcome decision',
          createdAt: new Date().toISOString(),
        };
      }
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

    // 0a. Check handoffPolicy if declared
    if (currentStage.handoffPolicy?.allowed && currentStage.handoffPolicy.conditionRef) {
      const handoffRule = release.rules?.find(
        (r) => r.ruleId === currentStage.handoffPolicy?.conditionRef || r.name === currentStage.handoffPolicy?.conditionRef
      );
      if (handoffRule) {
        const ruleExpr = handoffRule.condition?.ruleExpression || (handoffRule as any).expression;
        if (ruleExpr && evaluateControlledExpression(ruleExpr, workspace.facts)) {
          return {
            decisionId: `dec_${Date.now()}`,
            type: 'handoff',
            payload: { targetRole: currentStage.handoffPolicy.targetRole },
            reason: `Stage handoff triggered by condition rule '${currentStage.handoffPolicy.conditionRef}'`,
            createdAt: new Date().toISOString(),
          };
        }
      }
    }

    // 0b. NextDecisionPolicy === 'rule-first': evaluate stage exit conditions before checking missing facts
    if (currentStage.nextDecisionPolicy === 'rule-first') {
      const exitEvaluation = evaluateStageExit(currentStage, workspace.facts, release.rules);
      if (exitEvaluation.shouldTransition && exitEvaluation.nextStage) {
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'transition_stage',
          targetStage: exitEvaluation.nextStage,
          payload: {
            fromStage: currentStageId,
            toStage: exitEvaluation.nextStage,
          },
          reason: exitEvaluation.reason || `Rule-first policy triggered transition to '${exitEvaluation.nextStage}'`,
          createdAt: new Date().toISOString(),
        };
      }
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
    const exitEvaluation = evaluateStageExit(currentStage, workspace.facts, release.rules);
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

    // 3. Evaluate capability execution in the current stage via capabilityPlan or allowedCapabilities
    let targetCapability: string | null = null;

    if (currentStage.capabilityPlan && currentStage.capabilityPlan.length > 0) {
      for (const planItem of currentStage.capabilityPlan) {
        const { toolId, when, producesFacts } = planItem;
        // If all produced facts are already present in workspace.facts, this tool already ran successfully
        if (Array.isArray(producesFacts) && producesFacts.length > 0) {
          const allProducedPresent = producesFacts.every((fk) => {
            const fact = workspace.facts[fk];
            return fact !== undefined && fact.value !== undefined && fact.value !== null && fact.value !== '';
          });
          if (allProducedPresent) continue;
        }

        // Check when condition
        if (when) {
          if (typeof when === 'string') {
            const passed = evaluateControlledExpression(when, workspace.facts);
            if (!passed) continue;
          } else if (typeof when === 'object') {
            if (when.factsPresent && !areAllFactsPresent(workspace.facts, when.factsPresent)) {
              continue;
            }
            if (when.factsMissing && areAnyFactsPresent(workspace.facts, when.factsMissing)) {
              continue;
            }
            if (when.ruleExpression && !evaluateControlledExpression(when.ruleExpression, workspace.facts)) {
              continue;
            }
          }
        }

        targetCapability = toolId;
        break;
      }
    } else if (currentStage.allowedCapabilities && currentStage.allowedCapabilities.length > 0) {
      // Evaluate allowedCapabilities in order; find first tool whose mapped output facts are not all present
      for (const capId of currentStage.allowedCapabilities) {
        const stageBinding = release.capabilities?.stageBindings?.find(
          (sb) => sb.journeyId === journey.journeyId && sb.stageId === currentStageId
        );
        const stageTool = stageBinding?.tools?.find((t) => t.toolId === capId);
        const toolBinding = release.capabilities?.toolBindings?.find((tb) => tb.toolId === capId);
        const outputMap: Record<string, string> =
          (stageTool as any)?.outputFactMapping || (toolBinding as any)?.outputFactMapping || {};
        const mappedKeys = Object.keys(outputMap);
        if (mappedKeys.length > 0) {
          const allOutputsPresent = mappedKeys.every((fk) => {
            const f = workspace.facts[fk];
            return f !== undefined && f.value !== undefined && f.value !== null && f.value !== '';
          });
          if (allOutputsPresent) {
            // This capability's outputs are already present, check next capability
            continue;
          }
        }
        targetCapability = capId;
        break;
      }
    }

    if (targetCapability) {
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

      // Deterministic precedence for input mappings:
      // 1. Stage tool binding (highest precedence)
      // 2. Tenant tool binding (tenant default)
      // 3. Tool definition (base schema default)
      const stageBinding = release.capabilities?.stageBindings?.find(
        (sb) => sb.journeyId === journey.journeyId && sb.stageId === currentStageId
      );
      const stageTool = stageBinding?.tools?.find((t) => t.toolId === targetCapability);
      const toolBinding = release.capabilities?.toolBindings?.find((tb) => tb.toolId === targetCapability);

      const defMapping: Record<string, string> = (toolDef as any)?.inputMapping || {};
      const tenantMapping: Record<string, string> = (toolBinding as any)?.inputMapping || {};
      const stageMapping: Record<string, string> = (stageTool as any)?.inputMapping || {};

      const inputMapping: Record<string, string> = {
        ...defMapping,
        ...tenantMapping,
        ...stageMapping,
      };

      const inputSchema = toolDef.inputSchema || {};
      const schemaProperties = (inputSchema as any).properties || inputSchema;
      const schemaRequired: string[] = Array.isArray((inputSchema as any).required)
        ? (inputSchema as any).required
        : Object.entries(schemaProperties)
            .filter(([, def]: [string, any]) => def?.required === true)
            .map(([k]) => k);

      const mappedInputs: Record<string, any> = {};

      // 1. Map fields based on declared input schema and explicit mappings
      for (const [field] of Object.entries(schemaProperties)) {
        const sourceFactKey = inputMapping[field] || field;
        const sourceEntry = workspace.facts[sourceFactKey];
        if (sourceEntry && sourceEntry.value !== undefined && sourceEntry.value !== null) {
          mappedInputs[field] = sourceEntry.value;
        }

        // For retrieval query: ensure full customer question is available for knowledge retrieval
        if (field === 'query') {
          const userMsg = (command?.message || (command as any)?.userInput || '').trim();
          if (userMsg) {
            // Keep the customer's actual inquiry as the query so technical knowledge retrieval is grounded
            mappedInputs[field] = userMsg;
          }
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
      for (let [field, val] of Object.entries(mappedInputs)) {
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
            if (typeof val === 'object' && val !== null && ((val as any).amountCents !== undefined || (val as any).amount !== undefined || (val as any).value !== undefined)) {
              const num = Number((val as any).amountCents ?? (val as any).amount ?? (val as any).value);
              if (!isNaN(num)) {
                mappedInputs[field] = num;
                val = num;
              }
            }
            if (typeof val !== 'number') {
              return {
                decisionId: `dec_${Date.now()}`,
                type: 'fail',
                payload: { error: `Invalid type for input '${field}': expected number, got ${typeof val}` },
                reason: `Input type validation failed for '${field}'`,
                createdAt: new Date().toISOString(),
              };
            }
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

    // 4. Optional Facts: if requirements and capabilities are satisfied, check optional facts
    if (currentStage.optionalFacts && currentStage.optionalFacts.length > 0) {
      const normalizedOptional = normalizeFactRequirements(currentStage.optionalFacts);
      const missingOptional = normalizedOptional.filter((r) => {
        const fact = workspace.facts[r.key];
        return fact === undefined || fact.value === undefined || fact.value === null || fact.value === '';
      });
      if (missingOptional.length > 0) {
        const targetReq = missingOptional[0];
        const targetFact = targetReq.key;
        const slotQuestions = (release.vocabulary as any)?.slotQuestions || {};
        const slotDef = slotQuestions[targetFact] || (currentStage as any).questionDefinitions?.[targetFact];
        const questionText = targetReq.question || slotDef?.text || `Could you please specify your ${targetFact.replace(/_/g, ' ')}?`;
        const options = targetReq.options || slotDef?.options || [];
        return {
          decisionId: `dec_${Date.now()}`,
          type: 'ask_fact',
          payload: {
            targetFact,
            missingFacts: [targetFact],
            stage: currentStageId,
            question: questionText,
            options,
            optional: true,
          },
          reason: `Stage '${currentStageId}' asking optional fact '${targetFact}'`,
          createdAt: new Date().toISOString(),
        };
      }
    }

    // 5. Default: Stage requirements satisfied, waiting for user input or goal completed
    return {
      decisionId: `dec_${Date.now()}`,
      type: 'complete_goal',
      payload: { stage: currentStageId },
      reason: `All requirements for stage '${currentStageId}' satisfied.`,
      createdAt: new Date().toISOString(),
    };
  }
}
