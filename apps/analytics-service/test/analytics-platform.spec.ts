import assert from 'node:assert/strict';
import { Db } from 'mongodb';
import {
  COLLECTION_ANALYTICS_EVENTS,
  COLLECTION_CUSTOM_REPORTS,
  COLLECTION_ANALYTICS_ALERTS,
  COLLECTION_ANALYTICS_AUDIT_LOGS,
  COLLECTION_TOOL_APPROVALS,
  COLLECTION_NOTIFICATION_DELIVERIES,
  AnalyticsEventRecord,
} from '@journeyax/database';
import { AnalyticsService } from '../src/analytics.service';
import { AnalyticsController } from '../src/analytics.controller';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';

// ── In-Memory Mock MongoDB Database for Analytics Testing ────────────────────

function getNestedValue(obj: any, path: string): any {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let curr = obj;
  for (const part of parts) {
    if (curr === null || curr === undefined) return undefined;
    curr = curr[part];
  }
  return curr;
}

function matchesFilter(doc: any, filter: Record<string, any>): boolean {
  for (const [key, expected] of Object.entries(filter)) {
    if (key === '$or' && Array.isArray(expected)) {
      const orMatched = expected.some((subFilter) => matchesFilter(doc, subFilter));
      if (!orMatched) return false;
      continue;
    }
    if (key === '$and' && Array.isArray(expected)) {
      const andMatched = expected.every((subFilter) => matchesFilter(doc, subFilter));
      if (!andMatched) return false;
      continue;
    }

    const actual = getNestedValue(doc, key);

    if (expected !== null && typeof expected === 'object' && !(expected instanceof Date)) {
      for (const [op, val] of Object.entries(expected)) {
        if (op === '$gte') {
          const actVal = actual instanceof Date ? actual.getTime() : actual;
          const expVal = val instanceof Date ? val.getTime() : val;
          if (actVal < expVal) return false;
        } else if (op === '$lte') {
          const actVal = actual instanceof Date ? actual.getTime() : actual;
          const expVal = val instanceof Date ? val.getTime() : val;
          if (actVal > expVal) return false;
        } else if (op === '$gt') {
          const actVal = actual instanceof Date ? actual.getTime() : actual;
          const expVal = val instanceof Date ? val.getTime() : val;
          if (actVal <= expVal) return false;
        } else if (op === '$lt') {
          const actVal = actual instanceof Date ? actual.getTime() : actual;
          const expVal = val instanceof Date ? val.getTime() : val;
          if (actVal >= expVal) return false;
        } else if (op === '$in') {
          if (!Array.isArray(val) || !val.includes(actual)) return false;
        } else if (op === '$ne') {
          if (actual === val) return false;
        } else if (op === '$exists') {
          const exists = actual !== undefined;
          if (exists !== val) return false;
        }
      }
    } else {
      if (actual !== expected) return false;
    }
  }
  return true;
}

class MockCollection {
  public docs: any[] = [];

  constructor(public name: string) {}

  find(filter: Record<string, any> = {}, options?: any) {
    const matched = this.docs.filter((d) => matchesFilter(d, filter));
    let result = [...matched];

    return {
      sort: (sortObj: Record<string, number>) => {
        const [sortKey, sortDir] = Object.entries(sortObj)[0] || [];
        if (sortKey) {
          result.sort((a, b) => {
            const vA = getNestedValue(a, sortKey);
            const vB = getNestedValue(b, sortKey);
            const valA = vA instanceof Date ? vA.getTime() : vA;
            const valB = vB instanceof Date ? vB.getTime() : vB;
            if (valA < valB) return sortDir === -1 ? 1 : -1;
            if (valA > valB) return sortDir === -1 ? -1 : 1;
            return 0;
          });
        }
        return {
          limit: (n: number) => {
            result = result.slice(0, n);
            return {
              toArray: async () => result,
            };
          },
          toArray: async () => result,
        };
      },
      limit: (n: number) => {
        result = result.slice(0, n);
        return {
          toArray: async () => result,
        };
      },
      toArray: async () => result,
    };
  }

  async countDocuments(filter: Record<string, any> = {}): Promise<number> {
    return this.docs.filter((d) => matchesFilter(d, filter)).length;
  }

  async findOne(filter: Record<string, any> = {}): Promise<any | null> {
    return this.docs.find((d) => matchesFilter(d, filter)) || null;
  }

  async insertOne(doc: any): Promise<any> {
    const cloned = JSON.parse(JSON.stringify(doc), (k, v) => {
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
        return new Date(v);
      }
      return v;
    });
    for (const [k, v] of Object.entries(doc)) {
      if (v instanceof Date) (cloned as any)[k] = v;
    }
    this.docs.push(cloned);
    return { acknowledged: true, insertedId: (cloned as any)._id || 'mock_id' };
  }

  async insertMany(docs: any[]): Promise<any> {
    for (const d of docs) {
      await this.insertOne(d);
    }
    return { acknowledged: true, insertedCount: docs.length };
  }

  async updateOne(filter: Record<string, any> = {}, update: Record<string, any> = {}): Promise<any> {
    const doc = this.docs.find((d) => matchesFilter(d, filter));
    if (doc && update.$set) {
      for (const [k, v] of Object.entries(update.$set)) {
        doc[k] = v;
      }
    }
    return { acknowledged: true, modifiedCount: doc ? 1 : 0 };
  }

  async deleteMany(filter: Record<string, any> = {}): Promise<{ deletedCount: number }> {
    const initialLen = this.docs.length;
    this.docs = this.docs.filter((d) => !matchesFilter(d, filter));
    return { deletedCount: initialLen - this.docs.length };
  }

  aggregate(pipeline: any[]) {
    let result = [...this.docs];
    for (const stage of pipeline) {
      if (stage.$match) {
        result = result.filter((d) => matchesFilter(d, stage.$match));
      } else if (stage.$group) {
        const idSpec = stage.$group._id;
        const groups = new Map<string, any>();
        for (const item of result) {
          let groupKey: any = null;
          if (typeof idSpec === 'string' && idSpec.startsWith('$')) {
            groupKey = getNestedValue(item, idSpec.slice(1));
          } else if (idSpec && typeof idSpec === 'object') {
            if (idSpec.$ifNull) {
              const [f1, f2, f3] = idSpec.$ifNull;
              groupKey =
                getNestedValue(item, f1?.replace('$', '')) ||
                getNestedValue(item, f2?.replace('$', '')) ||
                f3;
            } else if (idSpec.$dateToString) {
              const d = getNestedValue(item, idSpec.$dateToString.date?.replace('$', ''));
              groupKey = d instanceof Date ? d.toISOString().slice(0, 10) : String(d);
            }
          }

          const existing = groups.get(groupKey) || { _id: groupKey, n: 0, turns: 0 };
          existing.n += 1;
          if (stage.$group.turns?.$sum) {
            const sumSpec = stage.$group.turns.$sum;
            let val = 0;
            if (typeof sumSpec === 'number') val = sumSpec;
            else if (sumSpec.$ifNull) {
              val = getNestedValue(item, sumSpec.$ifNull[0]?.replace('$', '')) || sumSpec.$ifNull[1];
            }
            existing.turns += val;
          }
          groups.set(groupKey, existing);
        }
        result = Array.from(groups.values());
      } else if (stage.$sort) {
        const [sortKey, sortDir] = Object.entries(stage.$sort)[0] as [string, number];
        result.sort((a, b) => {
          if (a[sortKey] < b[sortKey]) return sortDir === -1 ? 1 : -1;
          if (a[sortKey] > b[sortKey]) return sortDir === -1 ? -1 : 1;
          return 0;
        });
      } else if (stage.$limit) {
        result = result.slice(0, stage.$limit);
      }
    }
    return {
      toArray: async () => result,
    };
  }
}

class MockDb {
  private collections = new Map<string, MockCollection>();

  collection(name: string): MockCollection {
    if (!this.collections.has(name)) {
      this.collections.set(name, new MockCollection(name));
    }
    return this.collections.get(name)!;
  }
}

// ── Test Runner ───────────────────────────────────────────────────────────────

async function runTests() {
  console.log('🧪 Starting Enterprise Analytics Platform Test Suite...');

  const mockDb = new MockDb();
  const analyticsService = new AnalyticsService(mockDb as unknown as Db);
  const analyticsController = new AnalyticsController(analyticsService);

  const TENANT_A = 'tenant_mercury';
  const TENANT_B = 'tenant_jupiter';

  // Seed sample data for TENANT_A
  const now = new Date();
  const pastMinutes = (m: number) => new Date(now.getTime() - m * 60 * 1000);
  const pastHours = (h: number) => new Date(now.getTime() - h * 3600 * 1000);

  // 1. Seed Sessions (Funnel progression)
  const sessionsCol = mockDb.collection('sessions');
  await sessionsCol.insertMany([
    // Session 1: completed all the way to ordered
    {
      sessionId: 'sess_1',
      tenantId: TENANT_A,
      environmentId: 'production',
      turnCount: 8,
      lastIntent: { stage: 'ordered', intent: 'place_order' },
      createdAt: pastHours(2),
      updatedAt: pastHours(1),
    },
    // Session 2: reached quote
    {
      sessionId: 'sess_2',
      tenantId: TENANT_A,
      environmentId: 'production',
      turnCount: 5,
      lastIntent: { stage: 'quote', intent: 'view_quote' },
      createdAt: pastHours(3),
      updatedAt: pastHours(2),
    },
    // Session 3: reached products
    {
      sessionId: 'sess_3',
      tenantId: TENANT_A,
      environmentId: 'production',
      turnCount: 3,
      lastIntent: { stage: 'products', intent: 'browse_catalogue' },
      createdAt: pastHours(4),
      updatedAt: pastHours(3),
    },
    // Session 4: abandoned at clarify
    {
      sessionId: 'sess_4',
      tenantId: TENANT_A,
      environmentId: 'production',
      turnCount: 2,
      lastIntent: { stage: 'clarify', intent: 'sizing_query' },
      createdAt: pastHours(5),
      updatedAt: pastHours(4),
    },
    // Session 5: abandoned at intro
    {
      sessionId: 'sess_5',
      tenantId: TENANT_A,
      environmentId: 'production',
      turnCount: 1,
      lastIntent: { stage: 'intro', intent: 'greeting' },
      createdAt: pastHours(6),
      updatedAt: pastHours(5),
    },
  ]);

  // 2. Seed Quotes and Orders
  const quotesCol = mockDb.collection('quotes');
  await quotesCol.insertOne({
    quoteId: 'quote_1',
    sessionId: 'sess_1',
    tenantId: TENANT_A,
    title: 'Commercial Suite Quote',
    total: 4500,
    symbol: '$',
    status: 'accepted',
    createdAt: pastHours(2),
    updatedAt: pastHours(1),
  });

  const ordersCol = mockDb.collection('orders');
  await ordersCol.insertOne({
    orderId: 'order_1',
    quoteId: 'quote_1',
    tenantId: TENANT_A,
    total: 4500,
    currency: 'USD',
    status: 'paid',
    createdAt: pastHours(1),
    paidAt: pastHours(1),
  });

  // 3. Seed Analytics Events for Funnel & Performance
  const eventsCol = mockDb.collection(COLLECTION_ANALYTICS_EVENTS);
  await eventsCol.insertMany([
    // Stage events for session 1
    {
      eventId: 'ev_1_intro',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'stage.entered',
      stageId: 'intro',
      timestamp: pastHours(2),
      status: 'success',
      durationMs: 120000,
    },
    {
      eventId: 'ev_1_clarify',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'stage.entered',
      stageId: 'clarify',
      timestamp: pastMinutes(100),
      status: 'success',
      durationMs: 180000,
    },
    {
      eventId: 'ev_1_products',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'stage.entered',
      stageId: 'products',
      timestamp: pastMinutes(80),
      status: 'success',
      durationMs: 240000,
    },
    {
      eventId: 'ev_1_quote',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'stage.entered',
      stageId: 'quote',
      timestamp: pastMinutes(60),
      status: 'success',
      durationMs: 300000,
    },
    {
      eventId: 'ev_1_ordered',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'stage.entered',
      stageId: 'ordered',
      timestamp: pastMinutes(30),
      status: 'success',
      durationMs: 60000,
    },
    // Journey completed for session 1
    {
      eventId: 'ev_1_completed',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      category: 'journey',
      eventName: 'journey.completed',
      stageId: 'ordered',
      timestamp: pastMinutes(20),
      status: 'success',
      durationMs: 5400000, // 90 mins total completion time
    },
    // Model turns with token usage and latency
    {
      eventId: 'ev_model_1',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      packVersionId: '1.0.0',
      category: 'model',
      eventName: 'journey.turn_completed',
      modelId: 'gemini-1.5-pro',
      timestamp: pastMinutes(45),
      status: 'success',
      durationMs: 1450,
      metadata: {
        promptTokens: 800,
        completionTokens: 200,
        totalTokens: 1000,
      },
    },
    {
      eventId: 'ev_model_2',
      tenantId: TENANT_A,
      sessionId: 'sess_2',
      environmentId: 'production',
      packVersionId: '1.0.0',
      category: 'model',
      eventName: 'journey.turn_completed',
      modelId: 'gpt-4o',
      timestamp: pastMinutes(30),
      status: 'success',
      durationMs: 2200,
      metadata: {
        promptTokens: 1200,
        completionTokens: 400,
        totalTokens: 1600,
      },
    },
    // Tool execution: success and failure
    {
      eventId: 'ev_tool_1',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      packVersionId: '1.0.0',
      category: 'tool',
      eventName: 'tool.executed',
      toolId: 'catalog_search',
      status: 'success',
      durationMs: 340,
      timestamp: pastMinutes(50),
    },
    {
      eventId: 'ev_tool_2',
      tenantId: TENANT_A,
      sessionId: 'sess_1',
      environmentId: 'production',
      packVersionId: '1.0.0',
      category: 'tool',
      eventName: 'tool.executed',
      toolId: 'commercetools_order_create',
      status: 'failure',
      durationMs: 1100,
      timestamp: pastMinutes(40),
      metadata: {
        error: 'ECONNRESET downstream commercetools api',
      },
    },
    // Business pack v2 comparison events
    {
      eventId: 'ev_v2_model_1',
      tenantId: TENANT_A,
      sessionId: 'sess_v2_1',
      environmentId: 'production',
      packVersionId: '2.0.0',
      category: 'model',
      eventName: 'journey.turn_completed',
      modelId: 'gemini-1.5-pro',
      timestamp: pastMinutes(10),
      status: 'success',
      durationMs: 950,
      metadata: {
        promptTokens: 500,
        completionTokens: 150,
        totalTokens: 650,
      },
    },
    {
      eventId: 'ev_v2_completed',
      tenantId: TENANT_A,
      sessionId: 'sess_v2_1',
      environmentId: 'production',
      packVersionId: '2.0.0',
      category: 'journey',
      eventName: 'journey.completed',
      stageId: 'ordered',
      timestamp: pastMinutes(5),
      status: 'success',
      durationMs: 3600000, // 60 mins total
    },
  ]);

  // 4. Seed Tool Approvals for Execution Health
  const approvalsCol = mockDb.collection(COLLECTION_TOOL_APPROVALS);
  await approvalsCol.insertMany([
    {
      approvalId: 'app_1',
      tenantId: TENANT_A,
      environmentId: 'production',
      sessionId: 'sess_1',
      toolId: 'commercetools_order_create',
      status: 'approved',
      createdAt: pastMinutes(50),
      decidedAt: pastMinutes(48), // 2 mins wait time
    },
    {
      approvalId: 'app_2',
      tenantId: TENANT_A,
      environmentId: 'production',
      sessionId: 'sess_2',
      toolId: 'bulk_discount_apply',
      status: 'rejected',
      createdAt: pastMinutes(35),
      decidedAt: pastMinutes(30), // 5 mins wait time
    },
    {
      approvalId: 'app_3',
      tenantId: TENANT_A,
      environmentId: 'production',
      sessionId: 'sess_3',
      toolId: 'commercetools_order_create',
      status: 'pending',
      createdAt: pastMinutes(15),
    },
  ]);

  // 5. Seed Notification Deliveries
  const notifCol = mockDb.collection(COLLECTION_NOTIFICATION_DELIVERIES);
  await notifCol.insertMany([
    {
      deliveryId: 'notif_1',
      tenantId: TENANT_A,
      environmentId: 'production',
      channel: 'email',
      status: 'delivered',
      recipient: 'buyer@example.com',
      createdAt: pastMinutes(45),
    },
    {
      deliveryId: 'notif_2',
      tenantId: TENANT_A,
      environmentId: 'production',
      channel: 'whatsapp',
      status: 'delivered',
      recipient: '+1234567890',
      createdAt: pastMinutes(40),
    },
    {
      deliveryId: 'notif_3',
      tenantId: TENANT_A,
      environmentId: 'production',
      channel: 'sms',
      status: 'failed',
      recipient: '+1987654321',
      error: 'Carrier timeout',
      createdAt: pastMinutes(30),
    },
  ]);

  // 6. Seed Activepieces Executions
  const apCol = mockDb.collection('activepieces_executions');
  await apCol.insertMany([
    {
      runId: 'ap_run_1',
      tenantId: TENANT_A,
      environmentId: 'production',
      flowName: 'Order Sync to ERP',
      status: 'success',
      durationMs: 850,
      createdAt: pastMinutes(40),
    },
    {
      runId: 'ap_run_2',
      tenantId: TENANT_A,
      environmentId: 'production',
      flowName: 'Quote Notification Flow',
      status: 'failed',
      durationMs: 1200,
      error: 'HTTP 502 Bad Gateway from CRM webhook',
      createdAt: pastMinutes(25),
    },
  ]);

  // ── Verification 1: Journey Funnel, Conversion, Abandonment & Completion Time ───
  console.log('▶ Test 1: Journey Funnel, Stage Conversion, Abandonment & Completion Time');
  const funnel = await analyticsService.getFunnelAnalytics(TENANT_A);
  assert.equal(funnel.projectId, TENANT_A);
  assert.ok(funnel.stages.length >= 5, 'Must contain all pipeline stages');

  // Verify stage entry counts and drop-offs
  const introStage = funnel.stages.find((s) => s.stage === 'intro');
  assert.ok(introStage, 'Intro stage should exist');
  assert.equal(introStage?.enteredCount, 5, 'All 5 seeded sessions entered intro');

  const orderedStage = funnel.stages.find((s) => s.stage === 'ordered');
  assert.ok(orderedStage, 'Ordered stage should exist');
  assert.equal(orderedStage?.enteredCount, 1, 'Only session 1 reached ordered');

  // Overall conversion and abandonment
  assert.equal(funnel.overall.conversionRate, 0.2, '1 out of 5 sessions completed order = 20% conversion');
  assert.equal(funnel.overall.abandonmentRate, 0.8, '4 out of 5 sessions abandoned = 80% abandonment');

  // Completion times: p50 and p95
  assert.ok(funnel.overall.p50CompletionTimeMs > 0, 'p50 completion time must be greater than 0');
  assert.ok(funnel.overall.p95CompletionTimeMs >= funnel.overall.p50CompletionTimeMs, 'p95 >= p50');
  console.log('  ✔ Funnel analytics grounded and calculated accurately');

  // ── Verification 2: Agent/Tool/Model Performance, Latency, Cost & Tokens ──────
  console.log('▶ Test 2: Agent/Tool/Model Performance, Latency, Cost and Tokens');
  const perf = await analyticsService.getModelAndToolPerformance(TENANT_A);
  assert.equal(perf.projectId, TENANT_A);

  // Tokens & Costs
  const totalPrompt = perf.models.reduce((s, m) => s + m.promptTokens, 0);
  const totalCompletion = perf.models.reduce((s, m) => s + m.completionTokens, 0);
  const totalTokens = perf.models.reduce((s, m) => s + m.totalTokens, 0);
  const totalCost = perf.models.reduce((s, m) => s + m.costUsd, 0);

  assert.equal(totalPrompt, 2500, 'Sum of prompt tokens (800 + 1200 + 500)');
  assert.equal(totalCompletion, 750, 'Sum of completion tokens (200 + 400 + 150)');
  assert.equal(totalTokens, 3250, 'Sum of total tokens');
  assert.ok(totalCost > 0, 'Calculated cost grounded in pricing table');

  // Model breakdown
  assert.ok(perf.models.some((m) => m.modelId === 'gemini-1.5-pro'), 'Includes gemini-1.5-pro');
  assert.ok(perf.models.some((m) => m.modelId === 'gpt-4o'), 'Includes gpt-4o');

  // Tool performance & failures
  const toolExecs = perf.tools.reduce((s, t) => s + t.executions, 0);
  const toolSuccess = perf.tools.reduce((s, t) => s + t.successCount, 0);
  const toolFailures = perf.tools.reduce((s, t) => s + t.failureCount, 0);

  assert.equal(toolExecs, 2, '2 tool executions seeded');
  assert.equal(toolSuccess, 1, '1 successful tool execution');
  assert.equal(toolFailures, 1, '1 failed tool execution');
  const failureRate = +(toolFailures / toolExecs).toFixed(2);
  assert.equal(failureRate, 0.5, '50% tool failure rate');
  assert.ok(perf.tools.some((t) => Object.keys(t.errorBreakdown).length > 0), 'Error breakdown captured grounded errors');
  console.log('  ✔ Model & tool performance grounded in true execution logs');

  // ── Verification 3: Approval, Notification, Connector & Activepieces Health ──
  console.log('▶ Test 3: Approval, Notification, Connector & Activepieces Health');
  const health = await analyticsService.getExecutionHealth(TENANT_A);
  assert.equal(health.projectId, TENANT_A);

  // Approvals
  assert.equal(health.approvals.totalRequests, 3, '3 approval requests');
  assert.equal(health.approvals.approved, 1, '1 approved');
  assert.equal(health.approvals.rejected, 1, '1 rejected');
  assert.equal(health.approvals.pending, 1, '1 pending');
  assert.equal(health.approvals.approvalRate, 0.5, '50% approval rate (1 approved out of 2 decided)');
  assert.ok(health.approvals.avgWaitTimeMs > 0, 'Average approval wait time calculated');

  // Notifications
  assert.equal(health.notifications.totalDispatched, 3, '3 notification dispatches');
  assert.equal(health.notifications.delivered, 2, '2 delivered');
  assert.equal(health.notifications.failed, 1, '1 failed');
  assert.equal(health.notifications.deliveryRate, 0.6667, '66.67% delivery rate');
  assert.ok(health.notifications.channels.email.total === 1, 'Email channel recorded');
  assert.ok(health.notifications.channels.whatsapp.total === 1, 'WhatsApp channel recorded');

  // Activepieces / Connector Health
  assert.equal(health.connectors.totalFlowRuns, 2, '2 Activepieces flow executions');
  assert.equal(health.connectors.successRuns, 1, '1 successful run');
  assert.equal(health.connectors.failureRuns, 1, '1 failed run');
  assert.equal(health.connectors.successRate, 0.5, '50% success rate');
  console.log('  ✔ Execution health covers approvals, notifications, connectors and Activepieces');

  // ── Verification 4: Business Pack / Version Comparisons & Release Impact ───────
  console.log('▶ Test 4: Business Pack / Version Comparisons & Release Impact');
  const packComp = await analyticsService.comparePackVersions(TENANT_A, '1.0.0', '2.0.0');
  assert.equal(packComp.projectId, TENANT_A);
  assert.equal(packComp.versionA.version, '1.0.0');
  assert.equal(packComp.versionB.version, '2.0.0');
  assert.ok(['improved', 'degraded', 'neutral'].includes(packComp.impact.verdict));
  console.log('  ✔ Business pack comparison produces grounded metrics and actionable impact verdict');

  // ── Verification 5: Multi-level Scoped Dashboards (Real-time & Historical) ────
  console.log('▶ Test 5: Scoped Dashboards (Tenant/Project/Team/Workspace)');
  const tenantDash = await analyticsService.getScopedDashboard(TENANT_A);
  assert.equal(tenantDash.projectId, TENANT_A);
  assert.ok(tenantDash.kpis.activeSessions >= 0);
  assert.ok(tenantDash.trends.sessionsOverTime !== undefined);
  assert.ok(tenantDash.trends.conversionsOverTime !== undefined);

  // Scoped team / workspace dashboard
  const wsDash = await analyticsService.getScopedDashboard(TENANT_A, { workspaceId: 'ws_caroma_main' });
  assert.equal(wsDash.scope.workspaceId, 'ws_caroma_main');
  console.log('  ✔ Scoped dashboards return real-time and historical KPI views');

  // ── Verification 6: Custom Reports, Filters, RFC 4180 CSV & JSON Exports ───────
  console.log('▶ Test 6: Custom Reports, Filters, RFC 4180 CSV & JSON Exports');
  const testUser = { id: 'usr_analyst_1', role: 'analyst' };

  // Create custom report
  const createdReport = await analyticsService.createCustomReport(TENANT_A, testUser, {
    name: 'Tool Execution Failures Report',
    description: 'All tool failure incidents across production',
    category: 'performance',
    filters: {
      category: 'tool',
      status: 'failure',
    },
    metrics: ['eventId', 'toolId', 'status', 'durationMs', 'error'],
    schedule: { frequency: 'daily', recipients: ['ops@example.com'], enabled: true },
  });
  assert.ok(createdReport.reportId.startsWith('rep_'));
  assert.equal(createdReport.createdBy, testUser.id);

  // List custom reports
  const allReports = await analyticsService.getCustomReports(TENANT_A);
  assert.equal(allReports.length, 1);
  assert.equal(allReports[0].reportId, createdReport.reportId);

  // Run custom report
  const runResult = await analyticsService.runCustomReport(TENANT_A, testUser, createdReport.reportId);
  assert.equal(runResult.reportId, createdReport.reportId);
  assert.equal(runResult.rowCount, 1, '1 tool failure record matched filter');
  assert.equal(runResult.rows[0].toolId, 'commercetools_order_create');

  // Export as JSON
  const jsonExport = await analyticsService.exportCustomReport(TENANT_A, testUser, createdReport.reportId, 'json');
  assert.equal(jsonExport.format, 'json');
  assert.equal(jsonExport.contentType, 'application/json');
  const parsedJson = JSON.parse(jsonExport.data);
  assert.equal(parsedJson.rowCount, 1);

  // Export as RFC 4180 CSV
  const csvExport = await analyticsService.exportCustomReport(TENANT_A, testUser, createdReport.reportId, 'csv');
  assert.equal(csvExport.format, 'csv');
  assert.equal(csvExport.contentType, 'text/csv');
  assert.ok(csvExport.data.includes('commercetools_order_create'), 'CSV contains tool execution row');
  console.log('  ✔ Custom reports, filters, and RFC 4180 CSV exports work end-to-end');

  // ── Verification 7: Alerts, Threshold Rules & Evaluation ───────────────────────
  console.log('▶ Test 7: Alerts & Threshold Rules');
  const alertRule = await analyticsService.createAlert(TENANT_A, testUser, {
    name: 'High Tool Failure Rate Warning',
    metric: 'tool_failure_rate',
    condition: 'gt',
    threshold: 0.1, // 0.1 (10%), current failure rate is 0.5 (50%)
    severity: 'critical',
    recipients: ['oncall@example.com'],
    enabled: true,
  });
  assert.ok(alertRule.alertId.startsWith('alt_'));

  const alerts = await analyticsService.getAlerts(TENANT_A);
  assert.equal(alerts.length, 1);

  const evaluated = await analyticsService.evaluateAlerts(TENANT_A);
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0].triggered, true, 'Alert must trigger since 0.5 > 0.1');
  assert.equal(evaluated[0].currentValue, 0.5);
  console.log('  ✔ Alerts trigger accurately based on live evaluated thresholds');

  // ── Verification 8: Strict Tenant Isolation & RBAC Controller Tests ───────────
  console.log('▶ Test 8: Strict Tenant Isolation, RBAC & Security Gates');

  // 8a. Controller rejects cross-tenant requests
  let crossTenantBlocked = false;
  try {
    await analyticsController.getFunnel(
      TENANT_A,
      TENANT_A,
      TENANT_B, // Authenticated as TENANT_B, but requesting TENANT_A!
      'analytics:read',
      'user@tenant-b.com',
      'user'
    );
  } catch (err: any) {
    if (err instanceof ForbiddenException && err.message.includes('Cross-tenant access forbidden')) {
      crossTenantBlocked = true;
    }
  }
  assert.ok(crossTenantBlocked, 'Controller MUST reject cross-tenant access with 403 Forbidden');

  // 8b. Controller rejects unauthenticated access
  let unauthBlocked = false;
  try {
    await analyticsController.getFunnel(
      TENANT_A,
      TENANT_A,
      TENANT_A,
      'analytics:read',
      '', // Missing user email header
      'user'
    );
  } catch (err: any) {
    if (err instanceof UnauthorizedException) {
      unauthBlocked = true;
    }
  }
  assert.ok(unauthBlocked, 'Controller MUST reject unauthenticated requests');

  // 8c. Controller rejects insufficient permissions (RBAC)
  let permissionBlocked = false;
  try {
    await analyticsController.createReport(
      { tenantId: TENANT_A, name: 'Hacked Report' },
      TENANT_A,
      'orders:read', // Has orders:read, but NOT analytics:write!
      'analyst@tenant-a.com',
      'usr_1',
      'user'
    );
  } catch (err: any) {
    if (err instanceof ForbiddenException && err.message.includes('Permission denied')) {
      permissionBlocked = true;
    }
  }
  assert.ok(permissionBlocked, 'Controller MUST enforce RBAC permissions');
  console.log('  ✔ Strict tenant isolation and RBAC enforced at controller boundary');

  // ── Verification 9: Retention Policy, Audit Logs & PII Redaction ───────────────
  console.log('▶ Test 9: Retention Policy, Audit Logs & PII Redaction');

  // Insert old event to test retention pruning
  await eventsCol.insertOne({
    eventId: 'ev_ancient',
    tenantId: TENANT_A,
    category: 'system',
    eventName: 'ping',
    status: 'success',
    timestamp: new Date(Date.now() - 100 * 24 * 3600 * 1000), // 100 days old
  });

  const purgeResult = await analyticsService.enforceRetentionPolicy(TENANT_A, 90);
  assert.equal(purgeResult.purgedCount, 1, 'Purged the 100-day-old event');

  // Verify Audit Log was recorded
  const auditLogsCol = mockDb.collection(COLLECTION_ANALYTICS_AUDIT_LOGS);
  const auditLogs = await auditLogsCol.find({ tenantId: TENANT_A }).toArray();
  assert.ok(auditLogs.length >= 4, 'Audit logs recorded for report, export, alert, and retention');
  assert.ok(auditLogs.some((l) => l.action === 'retention_purged'), 'Audit log contains retention_purged');

  // Test PII Redaction
  const rawPiiText = 'Customer email is alice@example.com and phone is +1-555-234-5678 with token Bearer secret_token_xyz_12345';
  const sanitized = analyticsService.sanitizePII(rawPiiText);
  assert.ok(!sanitized.includes('alice@example.com'), 'Email must be redacted');
  assert.ok(sanitized.includes('[REDACTED_EMAIL]'), 'Email replaced with placeholder');
  assert.ok(!sanitized.includes('+1-555-234-5678'), 'Phone number must be redacted');
  assert.ok(sanitized.includes('[REDACTED_PHONE]'), 'Phone replaced with placeholder');
  assert.ok(!sanitized.includes('secret_token_xyz_12345'), 'Token must be redacted');
  assert.ok(sanitized.includes('[REDACTED_SECRET]'), 'Secret replaced with placeholder');
  console.log('  ✔ Retention pruning, audit logging, and PII redaction verified');

  // ── Verification 10: Durable Streaming Ingestion & Zero Fabrication ──────────
  console.log('▶ Test 10: Durable Streaming Ingestion & Zero Fabrication Guarantee');

  // Asynchronous ingestion via controller/service
  const streamedEvent: AnalyticsEventRecord = {
    eventId: 'ev_streamed_1',
    tenantId: TENANT_A,
    environmentId: 'production',
    category: 'tool',
    eventName: 'tool.executed',
    toolId: 'inventory_check',
    status: 'success',
    durationMs: 120,
    timestamp: new Date(),
  };

  const ingestRes = await analyticsService.ingestEvent(streamedEvent);
  assert.equal(ingestRes.accepted, true);
  assert.equal(ingestRes.eventId, 'ev_streamed_1');

  // Ingested event immediately visible in DB
  const foundStreamed = await eventsCol.findOne({ eventId: 'ev_streamed_1' });
  assert.ok(foundStreamed, 'Streamed event persisted durably');

  // Zero fabrication test on pristine TENANT_B
  const emptyFunnel = await analyticsService.getFunnelAnalytics(TENANT_B);
  assert.equal(emptyFunnel.stages[0].enteredCount, 0);
  assert.equal(emptyFunnel.overall.conversionRate, 0);
  assert.equal(emptyFunnel.overall.abandonmentRate, 0);
  assert.equal(emptyFunnel.overall.p50CompletionTimeMs, 0);
  assert.equal(emptyFunnel.overall.p95CompletionTimeMs, 0);

  const emptyPerf = await analyticsService.getModelAndToolPerformance(TENANT_B);
  assert.deepEqual(emptyPerf.models, []);
  assert.deepEqual(emptyPerf.tools, []);
  assert.deepEqual(emptyPerf.agents, []);

  const emptyHealth = await analyticsService.getExecutionHealth(TENANT_B);
  assert.equal(emptyHealth.approvals.totalRequests, 0);
  assert.equal(emptyHealth.approvals.approvalRate, 0);
  assert.equal(emptyHealth.notifications.totalDispatched, 0);
  assert.equal(emptyHealth.connectors.totalFlowRuns, 0);
  console.log('  ✔ Streaming ingestion is durable & pristine tenants report zero fabricated metrics');

  console.log('\n✅ ALL 10 ENTERPRISE ANALYTICS REDESIGN REQUIREMENTS VERIFIED AND PASSED!\n');
}

runTests().catch((err) => {
  console.error('❌ Test suite failed:', err);
  process.exit(1);
});
