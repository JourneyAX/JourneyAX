/**
 * @journeyax/journey-core — Domain-Neutral Journey Operating System Primitives
 *
 * Defines the executable state machine schemas, workspace state, transitions,
 * decisions, and UI instructions.
 */

export type FactSource = 'customer' | 'system' | 'inference' | 'tool' | 'external' | 'capability';

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
  ruleExpression?: string | null;
  /** Custom condition identifier defined in Business Pack rules */
  conditionRuleRef?: string | null;
  /** Target stage to transition into when condition matches */
  nextStage: string;
}

export type NextDecisionPolicy = 'dependency-first' | 'rule-first' | 'agent-driven' | 'capability-first';

export interface FactRequirement {
  key: string;
  priority?: number;
  reason?: string;
  question?: string;
  options?: string[];
  dependencies?: string[];
  required?: boolean;
  inputType?: 'single_select' | 'multi_select' | 'number' | 'measurement' | 'text';
  unit?: string;
  placeholder?: string;
  multi?: boolean;
}

export interface CapabilityPlanItem {
  toolId: string;
  when?: string | {
    factsPresent?: string[];
    factsMissing?: string[];
    ruleExpression?: string;
  };
  producesFacts?: string[];
}

export interface ConditionalFactRequirementGroup {
  when: string;
  facts: Array<string | FactRequirement>;
}

export interface JourneyStage {
  stageId?: string;
  displayName?: string | null;
  description?: string | null;
  requiredFacts: Array<string | FactRequirement>;
  optionalFacts?: Array<string | FactRequirement>;
  conditionalFacts?: ConditionalFactRequirementGroup[];
  allowedCapabilities: string[];
  blockedCapabilities?: string[];
  capabilityPlan?: CapabilityPlanItem[];
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
  displayName?: string | null;
  description?: string | null;
  goals: string[];
  initialStage: string;
  isDefaultConsultant?: boolean;
  triggerIntents?: string[];
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

export interface WorkspaceReleasePins {
  /** Checksum of the immutable Business Pack selected when the workspace was created. */
  packChecksum: string;
  /** Exact OKF release coupled to the Business Pack, when configured. */
  okfReleaseId?: string;
  okfChecksum?: string;
  /** Last time knowledge staleness/revocation policy was evaluated for this workspace. */
  knowledgeEvaluatedAt?: string | Date;
  pinnedAt: string | Date;
  /** Set when an idle workspace was moved onto a newer release under the pack's pin policy. */
  repinnedAt?: string | Date;
}

export interface WorkspaceKnowledgeContext {
  /** Exact immutable knowledge release that supplied the active concept. */
  releaseId: string;
  checksum: string;
  /** Internal routing context only; never exposed as a conversational fact. */
  conceptId: string;
  journeyId?: string;
  selectedAt: string | Date;
}

export interface WorkspaceState {
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  packVersionId: string;
  /** Optional for backward compatibility. New workspaces always receive immutable pins. */
  pins?: WorkspaceReleasePins;
  /** Release-scoped OKF context retained across short follow-up answers. */
  knowledgeContext?: WorkspaceKnowledgeContext;
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
  /** Transient: the pins/pack version were rebound this turn and must be persisted. Never stored. */
  pinsRebound?: boolean;
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

  projectId?: string;
  journeyId?: string;
  environment?: string;
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
      version?: string;
    };
    errors?: any[];
    events?: any[];
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
