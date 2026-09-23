export * from '../schemas/journey.schema';

export interface CanvasNodeData {
  kind: string; // 'trigger.start' | 'trigger.intent' | 'stage.node' | 'condition.branch' | 'action.ask' | 'action.recommend' | 'action.handoff' | 'tool.<id>'
  label: string;
  stageId?: string;
  intent?: string;
  condition?: string;
  ruleExpression?: string;
  requiredFacts?: string[];
  allowedCapabilities?: string[];
  text?: string;
  capabilityId?: string;
  [key: string]: any;
}

export interface CanvasNode {
  id: string;
  type?: string;
  data: CanvasNodeData;
  position: { x: number; y: number };
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  conditionExpression?: string;
}
