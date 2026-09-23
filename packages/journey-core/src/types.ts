/**
 * @journeyax/journey-core — Domain-Neutral Journey Operating System Primitives
 *
 * Defines the executable state machine schemas, workspace state, transitions,
 * decisions, and UI instructions.
 */

export type FactSource = 'customer' | 'system' | 'inference' | 'tool';

export interface FactEntry<T = any> {
  value: T;
  source: FactSource;
  confidence: number;
  verified?: boolean;
  extractedAt?: string;
  metadata?: Record<string, any>;
}

export type FactsMap = Record<string, FactEntry>;

export interface StageExitCondition {
  /** All listed fact keys must be present with truthy values */
  allFactsPresent?: string[];
  /** At least one of the listed fact keys must be present */
  anyFactsPresent?: string[];
  /** Expression to evaluate, e.g. "budget.amountCents <= 25000" */
  ruleExpression?: string;
  /** Custom condition identifier defined in Business Pack rules */
  conditionRuleRef?: string;
  /** Target stage to transition into when condition matches */
  nextStage: string;
}

export type NextDecisionPolicy = 'dependency-first' | 'rule-first' | 'agent-driven';

export interface JourneyStage {
  stageId?: string;
  displayName?: string;
  description?: string;
  requiredFacts: string[];
  optionalFacts?: string[];
  allowedCapabilities: string[];
  blockedCapabilities?: string[];
  nextDecisionPolicy?: NextDecisionPolicy;
  exitConditions: StageExitCondition[];
  handoffPolicy?: {
    allowed: boolean;
    targetRole?: string;
    conditionRef?: string;
  };
}

export interface JourneyDefinition {
  journeyId: string;
  version: string;
  displayName?: string;
  description?: string;
  goals: string[];
  initialStage: string;
  stages: Record<string, JourneyStage>;
  metadata?: Record<string, any>;
}

export type DecisionType =
  | 'ask_fact'
  | 'invoke_capability'
  | 'transition_stage'
  | 'complete_goal'
  | 'recommend'
  | 'handoff';

export interface Decision {
  decisionId: string;
  type: DecisionType;
  targetCapability?: string;
  targetStage?: string;
  payload: Record<string, any>;
  reason: string;
  priority?: number;
  createdAt: string;
}

export interface DecisionRecord extends Decision {
  executedAt?: string;
  outcomeStatus?: 'success' | 'failure' | 'cancelled' | 'pending';
  outcomeData?: any;
}

export interface Transition {
  fromStage: string;
  toStage: string;
  trigger: string;
  reason?: string;
  evaluatedAt: string;
}

export interface UIInstruction {
  component: string;
  props: Record<string, any>;
  actionId?: string;
  placement?: 'inline' | 'panel' | 'modal' | 'banner';
}

export type WorkspaceStatus = 'active' | 'completed' | 'paused' | 'failed';

export interface WorkspaceState {
  tenantId: string;
  workspaceId: string;
  packVersionId: string;
  journeyId: string;
  currentStage: string;
  goal: string;
  facts: FactsMap;
  decisions: DecisionRecord[];
  selectedObjects: any[];
  openQuestions: string[];
  status: WorkspaceStatus;
  createdAt: string | Date;
  updatedAt: string | Date;
  correlationId?: string;
}

export interface TurnCommand {
  tenantId: string;
  environmentId: string;
  workspaceId: string;
  sessionId: string;
  principalId?: string;
  message?: string;
  event?: {
    type: string;
    payload: any;
  };
  inputFacts?: Record<string, any>;
}

export interface TurnResult {
  workspace: WorkspaceState;
  decision: Decision;
  assistantMessage?: string;
  uiInstructions: UIInstruction[];
  executedCapabilities: {
    toolId: string;
    status: 'success' | 'failure';
    output: any;
  }[];
  trace: {
    stage: string;
    transitions: Transition[];
    decisionsMade: Decision[];
  };
}
