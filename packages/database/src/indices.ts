import { Db, IndexSpecification, CreateIndexesOptions } from 'mongodb';
import {
  COLLECTION_BUSINESS_PACK_RELEASES,
  COLLECTION_BUSINESS_PACK_POINTERS,
  COLLECTION_CUSTOMER_WORKSPACES,
  COLLECTION_TOOL_APPROVALS,
  COLLECTION_TOOL_EXECUTIONS,
  COLLECTION_OUTBOX_EVENTS,
  COLLECTION_PRODUCTS,
  COLLECTION_ORDERS,
  COLLECTION_QUOTES,
  COLLECTION_TENANT_CUTOVERS,
  COLLECTION_CUTOVER_AUDIT_LOGS,
  COLLECTION_GATEWAY_ASSERTION_NONCES,
  COLLECTION_ANALYTICS_EVENTS,
  COLLECTION_CUSTOM_REPORTS,
  COLLECTION_ANALYTICS_ALERTS,
  COLLECTION_ANALYTICS_AUDIT_LOGS,
} from './types';

async function safeCreateIndex(
  col: any,
  keys: IndexSpecification,
  options?: CreateIndexesOptions
): Promise<void> {
  try {
    await col.createIndex(keys, options);
  } catch (err: any) {
    // MongoDB code 85: Index already exists with a different name
    if (err.code === 85 || err.message?.includes('already exists')) {
      return;
    }
    throw err;
  }
}

/**
 * Idempotently ensures all canonical indexes across JourneyAX database collections.
 */
export async function ensureDatabaseIndices(db: Db): Promise<void> {
  // 1. Business Pack Releases: immutable releases per tenant/env/version
  const releases = db.collection(COLLECTION_BUSINESS_PACK_RELEASES);
  await safeCreateIndex(releases, { tenantId: 1, environmentId: 1, version: 1 }, { unique: true });
  await safeCreateIndex(releases, { tenantId: 1, environmentId: 1, publishedAt: -1 });

  // 2. Business Pack Pointers: single active pointer per tenant/env
  const pointers = db.collection(COLLECTION_BUSINESS_PACK_POINTERS);
  await safeCreateIndex(pointers, { tenantId: 1, environmentId: 1 }, { unique: true });

  // 3. Customer Workspaces: isolated multi-tenant workspaces with state version
  const workspaces = db.collection(COLLECTION_CUSTOMER_WORKSPACES);
  await safeCreateIndex(workspaces, { tenantId: 1, environmentId: 1, workspaceId: 1 }, { unique: true });
  await safeCreateIndex(workspaces, { tenantId: 1, environmentId: 1, updatedAt: -1 });

  // 4. Tool Approvals: secure approvals with input hash and TTL
  const approvals = db.collection(COLLECTION_TOOL_APPROVALS);
  await safeCreateIndex(approvals, { tenantId: 1, environmentId: 1, approvalRequestId: 1 }, { unique: true });
  await safeCreateIndex(approvals, { expiresAt: 1 }, { expireAfterSeconds: 0 });
  await safeCreateIndex(approvals, { tenantId: 1, environmentId: 1, workspaceId: 1, toolId: 1, status: 1 });
  await safeCreateIndex(approvals, { executionReference: 1 }, { sparse: true });
  await safeCreateIndex(approvals, { eventId: 1 }, { sparse: true });
  await safeCreateIndex(approvals, { consumedByEventId: 1 }, { sparse: true });

  // 5. Tool Executions: idempotent capability runs with input hash and TTL
  const executions = db.collection(COLLECTION_TOOL_EXECUTIONS);
  await safeCreateIndex(executions, { tenantId: 1, environmentId: 1, toolId: 1, idempotencyKey: 1 }, { unique: true });
  await safeCreateIndex(executions, { ttlExpiresAt: 1 }, { expireAfterSeconds: 0 });

  // 6. Outbox Events: transactional outbox with pending poller index
  const outbox = db.collection(COLLECTION_OUTBOX_EVENTS);
  await safeCreateIndex(outbox, { status: 1, createdAt: 1 });
  await safeCreateIndex(outbox, { status: 1, nextAttemptAt: 1, leaseExpiresAt: 1 });
  await safeCreateIndex(outbox, { tenantId: 1, environmentId: 1, eventType: 1 });

  // 7. Products: normalized catalog indices for fast grounded search
  const products = db.collection(COLLECTION_PRODUCTS);
  await safeCreateIndex(products, { projectId: 1, 'safety.toeProtection': 1 });
  await safeCreateIndex(products, { projectId: 1, category: 1 });

  // 8. Orders: authoritative unique idempotency and query indices
  const orders = db.collection(COLLECTION_ORDERS);
  await safeCreateIndex(orders, { projectId: 1, idempotencyKey: 1 }, { unique: true });
  await safeCreateIndex(orders, { projectId: 1, orderId: 1 }, { unique: true });
  await safeCreateIndex(orders, { projectId: 1, createdAt: -1 });

  // 9. Quotes: authoritative quote snapshot index
  const quotes = db.collection(COLLECTION_QUOTES);
  await safeCreateIndex(quotes, { projectId: 1, quoteId: 1 }, { unique: true });

  // 10. Tenant Cutovers: durable cutover records with unique tenant/env index
  const cutovers = db.collection(COLLECTION_TENANT_CUTOVERS);
  await safeCreateIndex(cutovers, { tenantId: 1, environmentId: 1 }, { unique: true });

  // 11. Cutover Audit Logs: immutable audit history per tenant/environment
  const cutoverAudit = db.collection(COLLECTION_CUTOVER_AUDIT_LOGS);
  await safeCreateIndex(cutoverAudit, { tenantId: 1, environmentId: 1, timestamp: -1 });

  // 12. Gateway Assertion Nonces: atomic replay protection with unique jti and TTL index
  const assertionNonces = db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES);
  await safeCreateIndex(assertionNonces, { jti: 1 }, { unique: true });
  await safeCreateIndex(assertionNonces, { expiresAt: 1 }, { expireAfterSeconds: 0 });

  // 13. Analytics Events: multi-dimensional analytics querying and time-series aggregations
  const analyticsEvents = db.collection(COLLECTION_ANALYTICS_EVENTS);
  await safeCreateIndex(analyticsEvents, { tenantId: 1, environmentId: 1, timestamp: -1 });
  await safeCreateIndex(analyticsEvents, { tenantId: 1, category: 1, timestamp: -1 });
  await safeCreateIndex(analyticsEvents, { tenantId: 1, workspaceId: 1, timestamp: -1 });
  await safeCreateIndex(analyticsEvents, { tenantId: 1, sessionId: 1, timestamp: -1 });
  await safeCreateIndex(analyticsEvents, { tenantId: 1, packVersionId: 1, timestamp: -1 });

  // 14. Custom Reports: tenant-scoped reports
  const customReports = db.collection(COLLECTION_CUSTOM_REPORTS);
  await safeCreateIndex(customReports, { tenantId: 1, reportId: 1 }, { unique: true });

  // 15. Analytics Alerts: tenant-scoped threshold alerts
  const analyticsAlerts = db.collection(COLLECTION_ANALYTICS_ALERTS);
  await safeCreateIndex(analyticsAlerts, { tenantId: 1, alertId: 1 }, { unique: true });

  // 16. Analytics Audit Logs: immutable audit history of report executions and exports
  const analyticsAudit = db.collection(COLLECTION_ANALYTICS_AUDIT_LOGS);
  await safeCreateIndex(analyticsAudit, { tenantId: 1, timestamp: -1 });
}
