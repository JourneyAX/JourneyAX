import { CanvasNode, CanvasEdge, JourneyDefinition, JourneyStage, StageExitCondition } from './schema';
import { validateGraphStructure } from './validator';

export interface CompilationOptions {
  journeyId: string;
  version?: string;
  displayName?: string;
  description?: string;
  goals?: string[];
}

export interface CompilationResult {
  success: boolean;
  journeyDefinition?: JourneyDefinition;
  errors?: string[];
  warnings?: string[];
}

export interface MultiJourneyCompilationResult {
  success: boolean;
  journeys?: JourneyDefinition[];
  errors?: string[];
  warnings?: string[];
}

/**
 * Compiles a React Flow visual graph containing one or more trigger nodes
 * into an array of strictly typed, executable JourneyDefinitions.
 */
export function compileGraphToJourneys(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: CompilationOptions
): MultiJourneyCompilationResult {
  const validation = validateGraphStructure(nodes, edges);
  if (!validation.valid) {
    return {
      success: false,
      errors: validation.issues.filter((i) => i.severity === 'error').map((i) => i.message),
      warnings: validation.issues.filter((i) => i.severity === 'warning').map((i) => i.message),
    };
  }

  const warnings = validation.issues.filter((i) => i.severity === 'warning').map((i) => i.message);

  const nodeMap = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n]));
  const adjacency = new Map<string, CanvasEdge[]>();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source)!.push(edge);
  }

  const triggerNodes = nodes.filter((n) => n.data?.kind?.startsWith('trigger.'));
  const effectiveTriggers = triggerNodes.length > 0 ? triggerNodes : [nodes[0]];

  const journeys: JourneyDefinition[] = [];

  for (let idx = 0; idx < effectiveTriggers.length; idx++) {
    const triggerNode = effectiveTriggers[idx];
    const triggerId = triggerNode.id;
    const triggerKind = triggerNode.data?.kind || 'trigger.intent';
    const triggerLabel = triggerNode.data?.label || `Journey ${idx + 1}`;
    const triggerIntent = triggerNode.data?.intent || '';

    // BFS/DFS from this trigger to collect all reachable node IDs
    const reachableNodeIds = new Set<string>([triggerId]);
    const queue = [triggerId];
    while (queue.length > 0) {
      const curr = queue.shift()!;
      const outEdges = adjacency.get(curr) || [];
      for (const edge of outEdges) {
        if (!reachableNodeIds.has(edge.target)) {
          const targetNode = nodeMap.get(edge.target);
          // Do not cross into another trigger node
          if (targetNode && !targetNode.data?.kind?.startsWith('trigger.')) {
            reachableNodeIds.add(edge.target);
            queue.push(edge.target);
          }
        }
      }
    }

    const stages: Record<string, JourneyStage> = {};
    const triggerStageId = sanitizeStageId(triggerNode.data?.stageId || triggerNode.id);

    // Initial stage is triggerStageId
    const triggerOutEdges = adjacency.get(triggerId) || [];
    const triggerExitConditions: StageExitCondition[] = triggerOutEdges.map((e) => {
      const targetNode = nodeMap.get(e.target);
      const targetStageId = sanitizeStageId(targetNode?.data?.stageId || targetNode?.id || 'next_stage');
      const ruleExpr = e.conditionExpression != null && e.conditionExpression !== '' ? String(e.conditionExpression) : undefined;
      return {
        nextStage: targetStageId,
        ...(ruleExpr ? { ruleExpression: ruleExpr } : {}),
      };
    });

    stages[triggerStageId] = {
      stageId: triggerStageId,
      displayName: triggerLabel,
      description: triggerIntent || `Entry stage triggered by ${triggerKind}`,
      requiredFacts: triggerNode.data?.requiredFacts || [],
      allowedCapabilities: triggerNode.data?.allowedCapabilities || [],
      nextDecisionPolicy: 'dependency-first',
      exitConditions: triggerExitConditions,
    };

    // Synthesize reachable non-trigger nodes
    for (const nodeId of reachableNodeIds) {
      if (nodeId === triggerId) continue;
      const node = nodeMap.get(nodeId);
      if (!node) continue;

      const kind = node.data?.kind || '';
      const stageId = sanitizeStageId(node.data?.stageId || node.id);
      const requiredFacts = [...(node.data?.requiredFacts || [])];
      const allowedCapabilities = [...(node.data?.allowedCapabilities || [])];

      if (kind === 'action.ask' && node.data?.factKey) {
        if (!requiredFacts.includes(node.data.factKey)) requiredFacts.push(node.data.factKey);
      }
      if (kind?.startsWith('tool.') && node.data?.capabilityId) {
        if (!allowedCapabilities.includes(node.data.capabilityId)) allowedCapabilities.push(node.data.capabilityId);
      }

      const outEdges = adjacency.get(node.id) || [];
      const exitConditions: StageExitCondition[] = outEdges.map((e) => {
        const targetNode = nodeMap.get(e.target);
        const targetStageId = sanitizeStageId(targetNode?.data?.stageId || targetNode?.id || 'end_stage');
        const rawRule = e.conditionExpression ?? node.data?.ruleExpression;
        const ruleExpr = rawRule != null && rawRule !== '' ? String(rawRule) : undefined;
        return {
          nextStage: targetStageId,
          ...(ruleExpr ? { ruleExpression: ruleExpr } : {}),
        };
      });

      const descRaw = node.data?.text ?? node.data?.description;
      const desc = descRaw != null && descRaw !== '' ? String(descRaw) : undefined;

      stages[stageId] = {
        stageId,
        displayName: node.data?.label || stageId,
        ...(desc ? { description: desc } : {}),
        requiredFacts,
        allowedCapabilities,
        nextDecisionPolicy: 'dependency-first',
        exitConditions,
      };
    }

    // Determine journey ID:
    const journeySlug = sanitizeStageId(triggerLabel.replace(/^Journey\s*\d+:\s*/i, ''));
    const journeyId =
      effectiveTriggers.length === 1
        ? options.journeyId
        : `${options.journeyId}_${journeySlug || triggerId}`;

    // Extract goals from label and intent
    const extractedGoalTokens = new Set<string>();
    const textToTokenize = `${triggerLabel} ${triggerIntent}`.toLowerCase();
    const rawTokens = textToTokenize.split(/[^a-z0-9]+/).filter((t) => t.length > 2);
    for (const token of rawTokens) {
      if (!['journey', 'the', 'and', 'for', 'any', 'all', 'what', 'with'].includes(token)) {
        extractedGoalTokens.add(token);
      }
    }
    // Enrich semantic triggerIntents and goals based on trigger labels and intents
    const triggerIntentsList: string[] = triggerIntent ? [triggerIntent] : [];
    const lowerLabel = triggerLabel.toLowerCase();
    const lowerIntent = triggerIntent.toLowerCase();

    if (lowerLabel.includes('shop') || lowerIntent.includes('product or material')) {
      triggerIntentsList.push('product_search', 'material_search', 'shop', 'find_product', 'screws', 'fasteners', 'hardware');
      extractedGoalTokens.add('product');
      extractedGoalTokens.add('material');
      extractedGoalTokens.add('screws');
      extractedGoalTokens.add('fasteners');
      extractedGoalTokens.add('hardware');
      extractedGoalTokens.add('items');
    }
    if (lowerLabel.includes('plan') || lowerIntent.includes('makeover')) {
      triggerIntentsList.push('plan_your_space', 'space_planner', 'bathroom_makeover', 'laundry_makeover', 'deck_estimator');
      extractedGoalTokens.add('bathroom');
      extractedGoalTokens.add('laundry');
      extractedGoalTokens.add('kitchen');
      extractedGoalTokens.add('decking');
      extractedGoalTokens.add('fencing');
      extractedGoalTokens.add('space');
    }
    if (lowerLabel.includes('tools') || lowerLabel.includes('guides') || lowerIntent.includes('compliance') || lowerIntent.includes('how-do-i')) {
      triggerIntentsList.push('product_advice', 'technical_advice', 'compliance_advice', 'installation_guide', 'linings', 'waterproofing', 'moisture');
      extractedGoalTokens.add('lining');
      extractedGoalTokens.add('linings');
      extractedGoalTokens.add('waterproofing');
      extractedGoalTokens.add('moisture');
      extractedGoalTokens.add('compliance');
      extractedGoalTokens.add('installation');
      extractedGoalTokens.add('wet');
      extractedGoalTokens.add('area');
      extractedGoalTokens.add('advice');
      extractedGoalTokens.add('guide');
    }
    if (lowerLabel.includes('customer') || lowerLabel.includes('service') || lowerIntent.includes('stock')) {
      triggerIntentsList.push('stock_lookup', 'branch_stock', 'stock_check', 'click_and_collect', 'pickup', 'delivery');
      extractedGoalTokens.add('stock');
      extractedGoalTokens.add('branch');
      extractedGoalTokens.add('pickup');
      extractedGoalTokens.add('delivery');
    }

    const goals =
      effectiveTriggers.length === 1 && options.goals && options.goals.length > 0
        ? options.goals
        : extractedGoalTokens.size > 0
        ? Array.from(extractedGoalTokens)
        : ['understand_need', 'resolve_solution'];

    journeys.push({
      journeyId,
      version: options.version || '1.0.0',
      displayName: triggerLabel || journeyId,
      description: triggerIntent || `${triggerLabel} flow`,
      goals,
      initialStage: triggerStageId,
      stages,
      metadata: {
        triggerIntents: triggerIntentsList,
      },
    });
  }

  return {
    success: true,
    journeys,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

/**
 * Compiles a React Flow visual graph (from JourneyBuilder canvas)
 * into a strictly typed, executable JourneyDefinition.
 */
export function compileGraphToJourneyDefinition(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: CompilationOptions
): CompilationResult {
  const multi = compileGraphToJourneys(nodes, edges, options);
  if (!multi.success || !multi.journeys || multi.journeys.length === 0) {
    return {
      success: false,
      errors: multi.errors,
      warnings: multi.warnings,
    };
  }
  return {
    success: true,
    journeyDefinition: multi.journeys[0],
    warnings: multi.warnings,
  };
}

function sanitizeStageId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
}
