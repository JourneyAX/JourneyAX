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
export const COLLECTION_CUTOVER_AUDIT_LOGS = 'cutover_audit_logs';
export const COLLECTION_GATEWAY_ASSERTION_NONCES = 'gateway_assertion_nonces';
export const COLLECTION_NOTIFICATION_DELIVERIES = 'notification_deliveries';

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
  recipient: string;
  status: 'delivered' | 'failed' | 'retrying';
  attempts: number;
  maxAttempts: number;
  templateId?: string;
  payload?: any;
  error?: string;
  deliveredAt?: Date;
  nextAttemptAt?: Date;
  createdAt: Date;
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

export interface DurableCutoverRecord {
  _id?: any;
  tenantId: string;
  environmentId: EnvironmentId;
  status: 'migrated' | 'canary' | 'unmigrated' | 'rollback';
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

export interface CutoverAuditLogRecord {
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

export interface GatewayAssertionNonceRecord {
  _id?: any;
  jti: string;
  tenantId: string;
  environmentId: string;
  expiresAt: Date;
  claimedAt: Date;
}
