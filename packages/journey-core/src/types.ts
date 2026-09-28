/**
 * @journeyax/journey-core — Domain-Neutral Journey Operating System Primitives
 *
 * Defines the executable state machine schemas, workspace state, transitions,
 * decisions, and UI instructions.
 */

export type FactSource = 'customer' | 'system' | 'inference' | 'tool' | 'external';

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

export interface FactRequirement {
  key: string;
  priority?: number;
  reason?: string;
  question?: string;
  options?: string[];
  dependencies?: string[];
  required?: boolean;
}

export interface JourneyStage {
  stageId?: string;
  displayName?: string;
  description?: string;
  requiredFacts: Array<string | FactRequirement>;
  optionalFacts?: Array<string | FactRequirement>;
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

export type EnvironmentId = 'dev' | 'test' | 'staging' | 'production';

export interface ChannelEvent {
  type: string;
  payload: any;
}

export type DecisionType =
  | 'ask_fact'
  | 'invoke_capability'
  | 'requires_approval'
  | 'transition_stage'
  | 'complete_goal'
  | 'handoff'
  | 'fail';

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

export interface CardEnvelope {
  name: 'presentCard';
  arguments: {
    card: {
      id: string;
      cardType: string;
      state: Record<string, any>;
      variant?: string;
      streamId?: string;
    };
  };
}

export interface UIInstruction {
  component: string;
  props: Record<string, any>;
  actionId?: string;
  placement?: 'inline' | 'panel' | 'modal' | 'banner';
  envelope?: CardEnvelope;
}

export type WorkspaceStatus = 'active' | 'completed' | 'paused' | 'failed';

export interface WorkspaceState {
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  packVersionId: string;
  journeyId: string;
  journeyVersion?: string;
  currentStage: string;
  goal: string;
  facts: FactsMap;
  decisions: DecisionRecord[];
  selectedObjects: any[];
  openQuestions: string[];
  status: WorkspaceStatus;
  stateVersion: number;
  lastProcessedTurnId?: string;
  createdAt: string | Date;
  updatedAt: string | Date;
  correlationId?: string;
}

export interface TurnCommand {
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  sessionId: string;

  turnId?: string;
  principalId?: string;
  principalRole?: string;
  correlationId: string;

  message?: string;
  event?: ChannelEvent;
  inputFacts?: Record<string, unknown>;

  approvalRequestId?: string;
  idempotencyKey?: string;
}

export interface TurnResult {
  workspace: WorkspaceState;
  decision: Decision;
  assistantMessage?: string;
  uiInstructions: UIInstruction[];
  executedCapabilities: {
    toolId: string;
    status: 'success' | 'failure' | 'requires_approval' | 'denied';
    output?: any;
    error?: string;
    approvalRequestId?: string;
  }[];
  trace: {
    stage: string;
    transitions: Transition[];
    decisionsMade: Decision[];
    modelRoute?: {
      policyId: string;
      provider: string;
      model: string;
      dataResidency: string;
    };
  };
}

/**
 * Base Domain Error for JourneyAX core runtime primitives.
 */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an identical turnId is replayed on a workspace whose lastProcessedTurnId matches.
 */
export class DuplicateTurnError extends DomainError {
  public readonly code = 'DUPLICATE_TURN';
  constructor(public readonly turnId: string, public readonly details?: string) {
    super(details || `Duplicate turn rejected: turnId='${turnId}' has already been processed`);
  }
}
