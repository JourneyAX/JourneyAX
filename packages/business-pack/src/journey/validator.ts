import { CanvasNode, CanvasEdge } from './schema';

export interface GraphValidationIssue {
  severity: 'error' | 'warning';
  nodeId?: string;
  edgeId?: string;
  message: string;
}

export interface GraphValidationResult {
  valid: boolean;
  issues: GraphValidationIssue[];
}

export function validateGraphStructure(
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): GraphValidationResult {
  const issues: GraphValidationIssue[] = [];
  const nodeMap = new Map<string, CanvasNode>(nodes.map((n) => [n.id, n]));

  // 1. Must have at least one trigger node
  const triggers = nodes.filter((n) => n.data?.kind?.startsWith('trigger.'));
  if (triggers.length === 0) {
    issues.push({
      severity: 'error',
      message: 'The journey graph must contain at least one Trigger node (Start or Intent).',
    });
  }

  // 2. Validate edge endpoints
  for (const edge of edges) {
    if (!nodeMap.has(edge.source)) {
      issues.push({
        severity: 'error',
        edgeId: edge.id,
        message: `Edge source '${edge.source}' does not exist in graph nodes.`,
      });
    }
    if (!nodeMap.has(edge.target)) {
      issues.push({
        severity: 'error',
        edgeId: edge.id,
        message: `Edge target '${edge.target}' does not exist in graph nodes.`,
      });
    }
  }

  // 3. Check for orphaned / unreachable nodes
  if (triggers.length > 0) {
    const visited = new Set<string>();
    const queue = triggers.map((t) => t.id);
    for (const tId of queue) visited.add(tId);

    const adjacency = new Map<string, string[]>();
    for (const e of edges) {
      if (!adjacency.has(e.source)) adjacency.set(e.source, []);
      adjacency.get(e.source)!.push(e.target);
    }

    while (queue.length > 0) {
      const current = queue.shift()!;
      const neighbors = adjacency.get(current) || [];
      for (const nextId of neighbors) {
        if (!visited.has(nextId)) {
          visited.add(nextId);
          queue.push(nextId);
        }
      }
    }

    for (const node of nodes) {
      if (!visited.has(node.id)) {
        issues.push({
          severity: 'warning',
          nodeId: node.id,
          message: `Node '${node.data?.label || node.id}' is unreachable from any trigger.`,
        });
      }
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
