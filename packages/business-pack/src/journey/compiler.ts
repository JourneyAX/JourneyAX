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

/**
 * Compiles a React Flow visual graph (from JourneyBuilder canvas)
 * into a strictly typed, executable JourneyDefinition.
 */
export function compileGraphToJourneyDefinition(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
  options: CompilationOptions
): CompilationResult {
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

  // Find primary trigger node
  const trigger = nodes.find((n) => n.data?.kind?.startsWith('trigger.')) || nodes[0];
  const initialStageId = sanitizeStageId(trigger.data?.stageId || trigger.data?.intent || 'entry_stage');

  const stages: Record<string, JourneyStage> = {};

  // Walk nodes to synthesize stages
  for (const node of nodes) {
    const kind = node.data?.kind || '';
    if (kind.startsWith('trigger.')) {
      const outEdges = adjacency.get(node.id) || [];
      const exitConditions: StageExitCondition[] = outEdges.map((e) => {
        const targetNode = nodeMap.get(e.target);
        const targetStageId = sanitizeStageId(targetNode?.data?.stageId || targetNode?.id || 'next_stage');
        return {
          nextStage: targetStageId,
          ruleExpression: e.conditionExpression,
        };
      });

      stages[initialStageId] = {
        stageId: initialStageId,
        displayName: node.data?.label || 'Entry Stage',
        description: `Entry stage triggered by ${kind}`,
        requiredFacts: node.data?.requiredFacts || [],
        allowedCapabilities: node.data?.allowedCapabilities || ['catalog.search'],
        nextDecisionPolicy: 'dependency-first',
        exitConditions,
      };
      continue;
    }

    // Process action/stage node
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
      return {
        nextStage: targetStageId,
        ruleExpression: e.conditionExpression || node.data?.ruleExpression,
      };
    });

    stages[stageId] = {
      stageId,
      displayName: node.data?.label || stageId,
      description: node.data?.text || node.data?.description,
      requiredFacts,
      allowedCapabilities,
      nextDecisionPolicy: 'dependency-first',
      exitConditions,
    };
  }

  // Ensure initialStage exists in stages
  if (!stages[initialStageId]) {
    stages[initialStageId] = {
      stageId: initialStageId,
      displayName: 'Start',
      requiredFacts: [],
      allowedCapabilities: ['catalog.search'],
      nextDecisionPolicy: 'dependency-first',
      exitConditions: [],
    };
  }

  const journeyDefinition: JourneyDefinition = {
    journeyId: options.journeyId,
    version: options.version || '1.0.0',
    displayName: options.displayName || options.journeyId,
    description: options.description,
    goals: options.goals && options.goals.length > 0 ? options.goals : ['understand_need', 'resolve_solution'],
    initialStage: initialStageId,
    stages,
  };

  return {
    success: true,
    journeyDefinition,
    warnings: warnings.length > 0 ? warnings : undefined,
  };
}

function sanitizeStageId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9_]/g, '_').replace(/^_+|_+$/g, '');
}
