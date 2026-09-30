import { EnvironmentId, WorkspaceState } from '@journeyax/journey-core';
export { EnvironmentId };

export const COLLECTION_BUSINESS_PACK_RELEASES = 'business_pack_releases';
export const COLLECTION_BUSINESS_PACK_POINTERS = 'business_pack_pointers';
export const COLLECTION_CUSTOMER_WORKSPACES = 'customer_workspaces';
export const COLLECTION_TOOL_APPROVALS = 'tool_approvals';
export const COLLECTION_TOOL_EXECUTIONS = 'tool_executions';
export const COLLECTION_OUTBOX_EVENTS = 'outbox_events';
export const COLLECTION_PRODUCTS = 'products';
export const COLLECTION_ORDERS = 'orders';
export const COLLECTION_QUOTES = 'quotes';
export const COLLECTION_TENANT_CUTOVERS = 'tenant_cutovers';
export const COLLECTION_RELEASE_ACTIVATIONS = COLLECTION_TENANT_CUTOVERS;
export const COLLECTION_CUTOVER_AUDIT_LOGS = 'cutover_audit_logs';
export const COLLECTION_RELEASE_ACTIVATION_AUDIT_LOGS = COLLECTION_CUTOVER_AUDIT_LOGS;
export const COLLECTION_GATEWAY_ASSERTION_NONCES = 'gateway_assertion_nonces';
export const COLLECTION_NOTIFICATION_DELIVERIES = 'notification_deliveries';
export const COLLECTION_NOTIFICATION_SUPPRESSIONS = 'notification_suppressions';
export const COLLECTION_NOTIFICATION_CALLBACKS = 'notification_callbacks';
export const COLLECTION_ANALYTICS_EVENTS = 'analytics_events';
export const COLLECTION_CUSTOM_REPORTS = 'custom_reports';
export const COLLECTION_ANALYTICS_ALERTS = 'analytics_alerts';
export const COLLECTION_ANALYTICS_AUDIT_LOGS = 'analytics_audit_logs';

export interface BusinessPackReleaseRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  version: string;
  checksum: string;
  manifest: any;
  profile: any;
  vocabulary?: any;
  entities?: any;
  conversationPolicy?: any;
  modelPolicy?: any;
  agents?: any;
  journeys?: any;
  rules?: any;
  capabilities?: any;
  experience?: any;
  evaluations?: any;
  publishedAt: Date;
  publishedBy: string;
}

export interface BusinessPackPointerRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  activeVersion: string;
  previousVersion?: string;
  revision: number;
  promotedAt: Date;
  promotedBy: string;
}

export type CustomerWorkspaceRecord = WorkspaceState;

export interface ToolApprovalRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  approvalRequestId: string;
  approvalId?: string;
  capabilityId?: string;
  toolId: string;
  inputHash: string;
  requestedPayload?: Record<string, any>;
  status: 'pending' | 'approved' | 'rejected' | 'expired' | 'consumed';
  requestedBy?: string;
  requestedAt: Date;
  expiresAt: Date;
  reviewedBy?: string;
  reviewedAt?: Date;
  reason?: string;
  consumedAt?: Date;

  // Immutable context bindings
  sessionId: string;
  stageId: string;
  packVersionId: string;
  principalId: string;
  principalRole: string;

  // Execution & event bindings
  executionReference: string;
  eventId?: string;
  consumedByEventId?: string;
}

export interface ToolExecutionRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  workspaceId: string;
  toolId: string;
  idempotencyKey: string;
  inputHash: string;
  status: 'started' | 'completed' | 'failed';
  result?: any;
  error?: any;
  startedAt: Date;
  completedAt?: Date;
  ttlExpiresAt?: Date;
}

export interface OutboxEventRecord {
  _id?: any;
  eventId: string;
  tenantId: string;
  environmentId: EnvironmentId;
  eventType: string;
  workspaceId?: string;
  sessionId?: string;
  toolId?: string;
  packVersionId?: string;
  approvalId?: string;
  executionReference?: string;
  payload: any;
  status: 'pending' | 'leased' | 'published' | 'failed' | 'dead_letter' | 'resolved';
  attempts: number;
  maxAttempts?: number;
  leasedBy?: string;
  leaseExpiresAt?: Date;
  nextAttemptAt?: Date;
  createdAt: Date;
  publishedAt?: Date;
  error?: string;
  resolutionNote?: string;
  resolvedAt?: Date;
}

export interface NormalizedProductRecord {
  _id?: any;
  projectId: string;
  parentSku: string;
  sku?: string;
  name: string;
  category: string;
  brand?: string;
  brandCode?: string;
  description?: string;
  price: {
    amount: number;
    currency: string;
    formatted?: string;
    min?: number;
    max?: number;
  };
  safety?: {
    toeProtection?: 'steel' | 'composite' | 'none';
    certifications?: string[];
    electricalHazardRated?: boolean;
    slipResistant?: boolean;
  };
  garment?: {
    weightClass?: 'lightweight' | 'midweight' | 'heavyweight';
    season?: string[];
    fabric?: string;
  };
  stock?: {
    inStock: boolean;
    availableQuantity?: number;
  };
  raw?: Record<string, any>;
  updatedAt: Date;
}

export interface NotificationDeliveryRecord {
  _id?: any;
  deliveryId: string;
  tenantId: string;
  environmentId?: EnvironmentId;
  eventId: string;
  channel: 'email' | 'webhook';
  provider?: 'sendgrid' | 'resend' | 'activepieces' | 'webhook' | 'smtp' | string;
  recipient: string;
  routingDecision?: {
    channel: 'email' | 'webhook';
    provider?: string;
    recipient: string;
    reason?: string;
  };
  templateId?: string;
  templateVersion?: string;
  status: 'delivered' | 'failed' | 'retrying' | 'bounced' | 'opened' | 'clicked' | 'dropped' | 'sent' | 'processed' | 'accepted';
  attempts: number;
  maxAttempts: number;
  providerDeliveryId?: string;
  deduplicationKey?: string;
  retrySchedule?: {
    nextAttemptAt?: Date;
    backoffMs: number;
    maxRetries: number;
  };
  payload?: any;
  metadata?: Record<string, any>;
  error?: string;
  deliveredAt?: Date;
  nextAttemptAt?: Date;
  createdAt: Date;
}

export interface NotificationSuppressionRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  recipient: string;
  channel: 'email' | 'webhook';
  reason: 'bounce' | 'complaint' | 'unsubscribe' | 'suppression';
  provider: string;
  providerDeliveryId?: string;
  createdAt: Date;
  updatedAt?: Date;
  metadata?: Record<string, any>;
}

export interface NotificationCallbackRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  provider: string;
  callbackId: string;
  deliveryId: string;
  status: string;
  processedAt: Date;
  rawPayload?: any;
}


export interface OrderRecord {
  _id?: any;
  orderId: string;
  idempotencyKey: string;
  projectId: string;
  environmentId?: EnvironmentId;
  userId?: string | null;
  status: 'pending_payment' | 'paid' | 'processing' | 'completed' | 'cancelled';
  quoteId?: string | null;
  items: Array<{
    sku: string;
    quantity: number;
    priceCents: number;
    name: string;
  }>;
  totalCents: number;
  currency: string;
  customerEmail?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface QuoteRecord {
  _id?: any;
  quoteId: string;
  projectId: string;
  environmentId?: EnvironmentId;
  userId?: string | null;
  currency: string;
  items: Array<{
    sku: string;
    quantity: number;
    priceCents: number;
    name: string;
  }>;
  totalCents: number;
  expiresAt: Date;
  status: 'active' | 'expired' | 'converted';
  createdAt: Date;
}

// Enterprise Release Concepts
export type TrafficPolicy = 'migrated' | 'canary' | 'unmigrated' | 'rollback';

export interface ReleaseApproval {
  approvedReleaseVersion: string;
  approvedReleaseChecksum: string;
  approvedBy: string;
  promotedAt: Date;
  notes?: string;
}

export interface CanaryPolicy {
  canaryPercentage?: number; // 0 - 100
}

export interface RollbackTarget {
  rollbackTargetVersion?: string;
}

export interface ActiveRelease {
  version: string;
  checksum: string;
}

export interface ReleaseActivationRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  status: TrafficPolicy;
  approvedReleaseChecksum: string;
  approvedReleaseVersion: string;
  canaryPercentage?: number; // 0 - 100
  revision: number;
  approvedBy: string;
  promotedAt: Date;
  rollbackTargetVersion?: string;
  notes?: string;
  updatedAt: Date;
}

// Deprecated alias for backward compatibility
export type DurableCutoverRecord = ReleaseActivationRecord;

export interface ReleaseActivationAuditLogRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  previousStatus: string;
  newStatus: string;
  previousRevision: number;
  newRevision: number;
  approvedReleaseVersion: string;
  approvedReleaseChecksum: string;
  canaryPercentage?: number;
  approvedBy: string;
  notes?: string;
  timestamp: Date;
}

// Deprecated alias for backward compatibility
export type CutoverAuditLogRecord = ReleaseActivationAuditLogRecord;

export interface GatewayAssertionNonceRecord {
  _id?: any;
  jti: string;
  tenantId: string;
  environmentId: string;
  expiresAt: Date;
  claimedAt: Date;
}

export type AnalyticsCategory =
  | 'journey'
  | 'model'
  | 'tool'
  | 'approval'
  | 'notification'
  | 'connector'
  | 'activepieces';

export interface AnalyticsEventRecord {
  _id?: any;
  eventId: string;
  tenantId: string;
  environmentId: EnvironmentId;
  projectId?: string;
  teamId?: string;
  workspaceId?: string;
  sessionId?: string;
  category: AnalyticsCategory;
  eventName: string;
  timestamp: Date;
  stageId?: string;
  fromStage?: string;
  toStage?: string;
  durationMs?: number;
  tokens?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
  costUsd?: number;
  modelId?: string;
  provider?: string;
  toolId?: string;
  status: 'success' | 'failure' | 'pending' | 'timeout' | 'rejected' | 'completed';
  errorCode?: string;
  errorMessage?: string;
  packId?: string;
  packVersionId?: string;
  principalId?: string;
  principalRole?: string;
  metadata?: Record<string, any>;
}

export interface CustomReportDefinition {
  _id?: any;
  reportId: string;
  tenantId: string;
  name: string;
  description?: string;
  filters: {
    startDate?: string;
    endDate?: string;
    environmentId?: EnvironmentId;
    projectId?: string;
    teamId?: string;
    workspaceId?: string;
    stages?: string[];
    tools?: string[];
    models?: string[];
    status?: string[];
  };
  metrics: string[];
  groupBy?: string[];
  schedule?: {
    cron?: string;
    enabled: boolean;
    recipients: string[];
    lastRunAt?: Date;
    nextRunAt?: Date;
  };
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface AnalyticsAlertDefinition {
  _id?: any;
  alertId: string;
  tenantId: string;
  name: string;
  metric: string;
  condition: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  threshold: number;
  windowMinutes: number;
  recipients: string[];
  enabled: boolean;
  lastTriggeredAt?: Date;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
}

export interface AnalyticsAuditLogRecord {
  _id?: any;
  logId: string;
  tenantId: string;
  action: 'report_created' | 'report_executed' | 'report_exported' | 'alert_created' | 'alert_triggered' | 'retention_purged';
  actorId: string;
  actorRole: string;
  targetId?: string;
  details?: Record<string, any>;
  timestamp: Date;
}
