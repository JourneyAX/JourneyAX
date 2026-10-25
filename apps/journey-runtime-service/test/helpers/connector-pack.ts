import { createHash } from 'node:crypto';
import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { WorkspaceState } from '@journeyax/journey-core';

export const TENANT = 'test-tenant';
export const SECRET_REF = `tenant-secret://${TENANT}/test/stock-key`;
export const SECRET_VALUE = 'canary-secret-for-connector-tests-0001';

/** A small pack with three agents (one that cannot reach connectors) and a connector registry. */
export function connectorPack(connectors?: unknown, options: { tenantId?: string; environmentId?: string; agents?: any[] } = {}): BusinessPackRelease {
  const tenantId = options.tenantId ?? TENANT;
  const environmentId = options.environmentId ?? 'test';
  const base = ['search_products', 'present_card', 'hand_off_to_human'];
  const agent = (agentId: string, allowedTools: string[], isDefault = false) => ({
    agentId, name: agentId, purpose: 'Help people with questions about the business.', systemPromptTemplate: 'You help people.',
    allowedTools, modelPolicyRef: 'default', maxTurns: 6, handoffConditions: [], ...(isDefault ? { isDefault: true } : {}),
  });
  return {
    manifest: { packId: 'connector-test-pack', tenantId, environmentId, version: '1.0.0', name: 'Connector test', description: 'x', status: 'active', publishedAt: new Date().toISOString(), publishedBy: 'test', checksum: 'chk' },
    profile: { companyName: 'Test Co', industry: 'Retail', primaryCurrency: 'NZD', supportedCurrencies: ['NZD'], primaryLocale: 'en-NZ', supportedLocales: ['en-NZ'], sellingScope: { inScope: ['things'], outOfScope: [] } },
    vocabulary: { version: '1.0.0', terms: [], acronyms: {}, slotSynonyms: {}, slotMappings: {}, prohibitedTerms: [] },
    entities: { version: '1.0.0', entities: [] },
    conversationPolicy: {
      fencingRules: [], prohibitedTopics: [], escalationThresholds: { sentimentFloor: -0.6, maxTurnsWithoutProgress: 4 },
      replyStyle: { maxSentences: 6, dropListLines: false, dropCompanyName: false, forbiddenPhrases: [], rules: [] },
      referrals: { 'en-NZ': ['consult a professional'] }, extraClaimPatterns: {}, withheldAnswerMessage: 'Withheld.',
    },
    journeys: [{ journeyId: 'general_journey', version: '1.0.0', goals: ['Help'], initialStage: 'stage_help', stages: { stage_help: { stageId: 'stage_help', displayName: 'Help', requiredFacts: [], allowedCapabilities: ['catalog.search'], nextDecisionPolicy: 'dependency-first', exitConditions: [] } } }],
    agents: options.agents ?? [
      agent('front_desk', [...base, 'list_connectors', 'get_connector_tools', 'call_connector_tool'], true),
      agent('no_connectors', base),
      agent('everything', ['*']),
    ],
    capabilities: { toolDefinitions: [], toolBindings: [], stageBindings: [] },
    extensions: { agentMode: { enabled: true }, dialoguePolicy: { agentMode: true }, ...(connectors ? { connectors } : {}) },
  } as any;
}

export function workspace(tenantId = TENANT, environmentId = 'test'): WorkspaceState {
  return {
    tenantId, environmentId, workspaceId: 'ws-connector-test', packVersionId: '1.0.0', journeyId: 'general_journey', currentStage: 'stage_help',
    goal: 'Help', facts: {}, decisions: [], selectedObjects: [], openQuestions: [], status: 'active', stateVersion: 1,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  } as any;
}

/** The registry used by the connector tests: staff may read and must ask before a write; a shopper may only look up stock. */
export const REGISTRY = {
  connectors: [
    {
      connectorId: 'stock-system', displayName: 'Stock system', description: 'Stock by branch and delivery status.', owner: 'Supply chain',
      secretRef: SECRET_REF, sample: true,
      tools: [
        { name: 'stock_by_branch', sideEffect: 'read', claimClasses: ['stock'] },
        { name: 'delivery_status', sideEffect: 'read' },
        { name: 'reserve_stock', sideEffect: 'write' },
      ],
    },
    {
      connectorId: 'crm', displayName: 'CRM', description: 'Accounts and support cases.', owner: 'Sales operations',
      tools: [{ name: 'find_account', sideEffect: 'read' }, { name: 'create_case', sideEffect: 'write' }],
    },
  ],
  policy: [
    { connectorId: 'stock-system', tool: 'stock_by_branch', audience: 'shopper', groups: [], state: 'allow' },
    { connectorId: 'stock-system', tool: '*', audience: 'staff', groups: [], state: 'allow' },
    { connectorId: 'stock-system', tool: 'reserve_stock', audience: 'staff', groups: [], state: 'ask' },
    { connectorId: 'stock-system', tool: 'delivery_status', audience: 'staff', groups: ['finance'], state: 'blocked' },
    { connectorId: 'crm', tool: '*', audience: 'staff', groups: ['customer-service'], state: 'allow' },
    { connectorId: 'crm', tool: 'create_case', audience: 'staff', groups: ['customer-service'], state: 'ask' },
  ],
};

const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${stable((value as any)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

/** An approval store in memory with the behaviour the connector runtime relies on (the real one needs a database). */
export class FakeApprovals {
  records = new Map<string, { id: string; toolId: string; hash: string; status: 'pending' | 'approved' | 'consumed'; tenantId: string; workspaceId: string; sessionId: string; principalRole: string }>();
  private n = 0;
  async createPending(toolId: string, input: unknown, ctx: any) {
    const id = `apr_test_${++this.n}`;
    this.records.set(id, { id, toolId, hash: createHash('sha256').update(stable(input)).digest('hex'), status: 'pending', tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, sessionId: ctx.sessionId, principalRole: ctx.principalRole });
    return { approvalRequestId: id, expiresAt: new Date(Date.now() + 15 * 60_000) };
  }
  async getApproval(id: string) {
    const record = this.records.get(id);
    return record ? { status: record.status, toolId: record.toolId, tenantId: record.tenantId, workspaceId: record.workspaceId } : null;
  }
  approve(id: string) { this.records.get(id)!.status = 'approved'; }
  async consumeApproved(id: string, toolId: string, input: unknown, ctx: any) {
    const record = this.records.get(id);
    if (!record || record.status !== 'approved' || record.toolId !== toolId || record.tenantId !== ctx.tenantId || record.sessionId !== ctx.sessionId || record.principalRole !== ctx.principalRole) return false;
    if (record.hash !== createHash('sha256').update(stable(input)).digest('hex')) return false;
    record.status = 'consumed';
    return true;
  }
}
