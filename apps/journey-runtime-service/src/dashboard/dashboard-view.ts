import { buildDashboard, connectorToolState, dashboardCalls, dashboardFor, dashboardName, type CallOutcome, type DashboardCall, type DashboardView } from '@journeyax/business-pack';
import type { ConnectorRuntime } from '../kernel/connector.runtime';
import { dashboardFormat } from '../agent/record-cards';

/**
 * The corner tile and the dashboard for one signed-in person. The pack says which connector tools feed which figures (`extensions.dashboard`);
 * each is called here through the same connector gate the assistant uses, for this person, so a tool they may not use leaves its figure
 * blank and nothing else. Only tools the pack lists as read-only are ever called, whatever the dashboard setting says.
 *
 * Answers are kept for a short while per person, so a tile that refreshes itself does not ask Salesforce again every time.
 */
export interface DashboardDeps {
  runtime: Pick<ConnectorRuntime, 'call'>;
  /** How long an answer is reused, in ms. */
  cacheMs?: number;
  /** How long one call may take before its figure is left blank, in ms. */
  callTimeoutMs?: number;
  now?: () => Date;
}

export interface DashboardRequest {
  tenantId: string;
  environmentId: string;
  release: { extensions?: Record<string, any>; profile?: { primaryCurrency?: string; primaryLocale?: string }; manifest?: { packId?: string; version?: string } };
  person: { userId?: string; role?: string; audience: 'shopper' | 'staff'; groups: string[] };
}

const DEFAULT_CACHE_MS = 45_000;
const DEFAULT_CALL_TIMEOUT_MS = 8_000;
const MAX_CACHED = 500;

interface Cached { at: number; outcome: CallOutcome }

export class DashboardViewService {
  private readonly cache = new Map<string, Cached>();

  constructor(private readonly deps: DashboardDeps) {}

  async load(request: DashboardRequest): Promise<DashboardView | undefined> {
    const setting = request.release.extensions?.dashboard;
    const entry = dashboardFor(setting, { audience: request.person.audience, groups: request.person.groups, userId: request.person.userId });
    if (!entry) return undefined;
    const name = dashboardName(setting, request.person.userId);
    const calls = dashboardCalls(entry, name);
    const outcomes = new Map<string, CallOutcome>();
    await Promise.all(calls.map(async (call) => { outcomes.set(call.key, await this.outcomeOf(request, call)); }));
    const now = this.deps.now?.() ?? new Date();
    return buildDashboard(entry, outcomes, { format: dashboardFormat(request.release, setting, now), name, now });
  }

  private async outcomeOf(request: DashboardRequest, call: DashboardCall): Promise<CallOutcome> {
    const now = (this.deps.now?.() ?? new Date()).getTime();
    const cacheKey = `${request.tenantId}|${request.person.userId ?? ''}|${call.key}`;
    const kept = this.cache.get(cacheKey);
    if (kept && now - kept.at < (this.deps.cacheMs ?? DEFAULT_CACHE_MS)) return kept.outcome;

    // Only a tool the pack lists as one that reads is ever called for a dashboard.
    const listed = request.release.extensions?.connectors?.connectors
      ?.find((connector: any) => connector.connectorId === call.connector && connector.enabled !== false)
      ?.tools?.find((tool: any) => tool.name === call.tool);
    if (!listed || listed.sideEffect !== 'read') return { ok: false, reason: 'blocked' };
    // A dashboard never asks a person for a yes: a tool that is ask-first or blocked for them is simply not read.
    const { state } = connectorToolState(request.release.extensions?.connectors, call.connector, call.tool, { audience: request.person.audience, groups: request.person.groups });
    if (state !== 'allow') return { ok: false, reason: 'blocked' };

    const outcome = await this.ask(request, call);
    if (outcome.ok) {
      if (this.cache.size >= MAX_CACHED) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(cacheKey, { at: now, outcome });
    }
    return outcome;
  }

  private async ask(request: DashboardRequest, call: DashboardCall): Promise<CallOutcome> {
    const correlationId = `dashboard_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const context = {
      tenantId: request.tenantId,
      environmentId: request.environmentId,
      workspaceId: 'dashboard',
      sessionId: 'dashboard',
      principalId: request.person.userId || 'anonymous',
      principalRole: request.person.role || 'staff',
      stageId: 'dashboard',
      packVersionId: request.release.manifest?.version || request.release.manifest?.packId || '1.0.0',
      correlationId,
      idempotencyKey: correlationId,
      release: request.release,
      packSettings: request.release,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer: any = await Promise.race([
        this.deps.runtime.call(request.release as any, { audience: request.person.audience, groups: request.person.groups }, context as any, call.connector, call.tool, call.args),
        new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), this.deps.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS); }),
      ]);
      if (answer?.ok === true) return { ok: true, data: answer.result };
      // Blocked, ask-first (a dashboard never asks) and not-found all mean this person may not read it.
      return { ok: false, reason: answer?.status === 'blocked' || answer?.status === 'not_found' || answer?.status === 'needs_approval' ? 'blocked' : 'unavailable' };
    } catch {
      return { ok: false, reason: 'unavailable' };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
