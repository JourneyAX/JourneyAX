import * as fs from 'fs';
import * as path from 'path';
import { BusinessPackRelease, BusinessPackLoader } from '@journeyax/business-pack';
import { TurnCommand, TurnResult } from '@journeyax/journey-core';

export interface EvaluationScenarioAssertion {
  type: string;
  field?: string;
  expected?: any;
  description?: string;
}

export interface EvaluationScenario {
  scenarioId: string;
  name: string;
  description?: string;
  messages?: string[];
  prompt?: string;
  expectedTargetStage?: string;
  expectedStage?: string;
  expectedFacts?: string[];
  requiredCapabilities?: string[];
  expectedCapabilities?: string[];
  forbiddenSubstrings?: string[];
  assertions?: EvaluationScenarioAssertion[];
  timeoutMs?: number;
}

export interface EvaluationSuite {
  suiteId: string;
  name: string;
  tenantId: string;
  version: string;
  blockingOnPublish?: boolean;
  deterministicOffline?: boolean;
  executionMode?: string;
  scenarios: EvaluationScenario[];
}

export interface ScenarioTurnLog {
  turnIndex: number;
  customerMessage: string;
  assistantMessage?: string;
  stage: string;
  decisionType: string;
  executedCapabilities: string[];
  facts: Record<string, any>;
  cardTypes: string[];
}

export interface ScenarioExecutionResult {
  scenarioId: string;
  name: string;
  passed: boolean;
  finalStage: string;
  expectedStage: string;
  capturedFacts: Record<string, any>;
  executedCapabilities: string[];
  turns: ScenarioTurnLog[];
  failures: string[];
  durationMs: number;
}

export interface EvaluationSuiteResult {
  suiteId: string;
  tenantId: string;
  environmentId: string;
  passed: boolean;
  totalScenarios: number;
  passedScenarios: number;
  failedScenarios: number;
  scenarios: ScenarioExecutionResult[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export type EvaluationExecutionMode = 'http' | 'in_process';

export interface RunEvaluationOptions {
  tenantId: string;
  environmentId?: 'dev' | 'test' | 'staging' | 'production';
  mode?: EvaluationExecutionMode;
  runtimeUrl?: string;
  packDir?: string;
  release?: BusinessPackRelease;
  suitePath?: string;
  verbose?: boolean;
  isolatedDb?: any;
  repositories?: {
    workspaceRepo?: any;
    executionRepo?: any;
    outboxRepo?: any;
    capabilityGateway?: any;
  };
}

export class EvaluationRunner {
  private runtimeUrl: string;

  constructor(runtimeUrl?: string) {
    this.runtimeUrl =
      runtimeUrl ||
      process.env.JOURNEY_RUNTIME_SERVICE_URL ||
      process.env.RUNTIME_SERVICE_URL ||
      'http://localhost:3012';
  }

  async runSuite(options: RunEvaluationOptions): Promise<EvaluationSuiteResult> {
    // Invariant: Never mutate process.env.NODE_ENV or ALLOW_IN_MEMORY_* inside EvaluationRunner.
    // Isolated evaluation receives explicit repositories or isolated storage configuration.
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const tenantId = options.tenantId;
    const environmentId = options.environmentId || 'production';
    const mode: EvaluationExecutionMode =
      options.mode ||
      (process.env.EVAL_MODE as EvaluationExecutionMode) ||
      'in_process';

    // 1. Resolve Business Pack release (either explicitly provided or from active database pointer)
    let release = options.release;
    if (!release) {
      const loader = new BusinessPackLoader({ db: options.isolatedDb });
      release = (await loader.loadPublished(tenantId, environmentId).catch(() => null)) || undefined;
      if (!release) {
        throw new Error(
          `[EvaluationRunner] Failed to load Business Pack release for tenant '${tenantId}' (active database release or explicit options.release required)`
        );
      }
    }

    // 2. Locate suite definition from explicit suitePath or compiled release.evaluations
    let suite: EvaluationSuite | undefined;
    if (options.suitePath && fs.existsSync(options.suitePath)) {
      suite = JSON.parse(fs.readFileSync(options.suitePath, 'utf8'));
    } else if (release?.evaluations && release.evaluations.length > 0) {
      suite = release.evaluations[0] as EvaluationSuite;
    }

    if (!suite) {
      throw new Error(
        `[EvaluationRunner] No evaluation suite found for tenant '${tenantId}'. Provide an explicit options.suitePath or compile evaluations into the Business Pack release.`
      );
    }

    const isBlocking = suite.blockingOnPublish !== false;
    const isDeterministicOffline = Boolean(
      (suite as any).deterministicOffline ||
      (suite as any).executionMode === 'deterministic_offline'
    );

    // Explicit per-tenant/per-release in-process service instance (NEVER cached across runs)
    const inProcessService = mode === 'in_process' ? this.createInProcessService(release, options) : null;
    const hasApprovedIsolatedAdapter = mode === 'in_process' && Boolean(inProcessService);

    const isModelCredentialOrResidencyError = (errOrMsg: any): boolean => {
      if (!errOrMsg) return false;
      const msg = typeof errOrMsg === 'string' ? errOrMsg : (errOrMsg.message || errOrMsg.code || '');
      const lower = msg.toLowerCase();
      return (
        lower.includes('missing_credentials') ||
        lower.includes('missing required api credentials') ||
        lower.includes('no configured api credentials found') ||
        lower.includes('residency_violation') ||
        lower.includes('residency violation') ||
        lower.includes('data residency violation')
      );
    };

    const scenarioResults: ScenarioExecutionResult[] = [];
    const forbiddenPatterns = ['Stage \'', 'Capability \'', 'requires input'];

    for (const scenario of suite.scenarios) {
      const scenarioStart = Date.now();
      const failures: string[] = [];
      const turnsLog: ScenarioTurnLog[] = [];
      const executedCapabilitiesAcrossTurns = new Set<string>();
      const workspaceId = `eval-${tenantId}-${scenario.scenarioId}-${Date.now()}`;
      const sessionId = `sess-${workspaceId}`;

      const messages = scenario.messages || (scenario.prompt ? [scenario.prompt] : []);
      if (messages.length === 0) {
        failures.push(`Scenario '${scenario.scenarioId}' defines no customer messages`);
      }

      let lastTurnResult: any = null;

      for (let tIdx = 0; tIdx < messages.length; tIdx++) {
        const msg = messages[tIdx];
        const turnCmd: TurnCommand = {
          tenantId,
          environmentId,
          workspaceId,
          sessionId,
          correlationId: `corr-${scenario.scenarioId}-${tIdx + 1}`,
          turnId: `turn-${scenario.scenarioId}-${tIdx + 1}-${Date.now()}`,
          message: msg,
        };

        // ENFORCE EVAL-001: inputFacts are strictly forbidden in evaluation runner!
        if ((turnCmd as any).inputFacts) {
          throw new Error('[EvaluationRunner] Injection of inputFacts is forbidden by evaluation policy');
        }
        if ((turnCmd as any).journeyId) {
          throw new Error('[EvaluationRunner] Injection of journeyId is forbidden by evaluation policy');
        }

        let res: TurnResult;
        let turnError: Error | null = null;
        try {
          res = await this.executeTurn(turnCmd, release, mode, inProcessService);
        } catch (err: any) {
          turnError = err;
        }

        if (turnError) {
          if (isBlocking && isModelCredentialOrResidencyError(turnError) && !(isDeterministicOffline && hasApprovedIsolatedAdapter)) {
            failures.push(`Blocking evaluation failed on model credential/residency error: ${turnError.message}`);
          } else {
            failures.push(`Turn ${tIdx + 1} execution threw: ${turnError.message}`);
          }
          break;
        }

        lastTurnResult = res;

        // Check trace errors for model credential or residency error in blocking evaluations
        const traceErrors = (res.trace as any)?.errors || [];
        for (const trErr of traceErrors) {
          if (isModelCredentialOrResidencyError(trErr)) {
            if (isBlocking && !(isDeterministicOffline && hasApprovedIsolatedAdapter)) {
              failures.push(
                `Blocking evaluation failed on model credential/residency error: ${typeof trErr === 'string' ? trErr : (trErr.message || JSON.stringify(trErr))}`
              );
            }
          }
        }

        // Check forbidden substrings in assistant message
        const assistantText = res.assistantMessage || '';
        for (const forbidden of scenario.forbiddenSubstrings || forbiddenPatterns) {
          if (assistantText.includes(forbidden)) {
            failures.push(
              `Turn ${tIdx + 1}: Assistant text contains forbidden substring '${forbidden}': "${assistantText}"`
            );
          }
        }

        const turnExecutedCaps: string[] = (res.executedCapabilities || []).map((c: any) => c.toolId);
        for (const cap of turnExecutedCaps) {
          executedCapabilitiesAcrossTurns.add(cap);
        }

        const cardTypes = ((res as any).cards || (res as any).uiCards || []).map((c: any) => c.type || c.cardType);

        turnsLog.push({
          turnIndex: tIdx + 1,
          customerMessage: msg,
          assistantMessage: assistantText,
          stage: res.workspace?.currentStage || 'unknown',
          decisionType: res.decision?.type || 'unknown',
          executedCapabilities: turnExecutedCaps,
          facts: res.workspace?.facts ? Object.fromEntries(Object.entries(res.workspace.facts).map(([k, v]: any) => [k, v?.value])) : {},
          cardTypes,
        });
      }

      // Check Scenario Level Assertions
      const finalStage = lastTurnResult?.workspace?.currentStage || 'unknown';
      const expectedStage = scenario.expectedTargetStage || scenario.expectedStage;
      if (expectedStage && finalStage !== expectedStage) {
        failures.push(
          `Expected final stage '${expectedStage}' but reached '${finalStage}'`
        );
      }

      const capturedFacts: Record<string, any> = lastTurnResult?.workspace?.facts
        ? Object.fromEntries(Object.entries(lastTurnResult.workspace.facts).map(([k, v]: any) => [k, v?.value]))
        : {};

      for (const reqFact of scenario.expectedFacts || []) {
        if (capturedFacts[reqFact] === undefined || capturedFacts[reqFact] === null) {
          failures.push(`Expected fact '${reqFact}' was not captured in workspace state`);
        }
      }

      for (const reqCap of scenario.requiredCapabilities || scenario.expectedCapabilities || []) {
        if (!executedCapabilitiesAcrossTurns.has(reqCap)) {
          failures.push(`Required capability '${reqCap}' was not executed across turns`);
        }
      }

      // Custom assertions
      for (const assertion of scenario.assertions || []) {
        if (assertion.type === 'fact_present' && assertion.field) {
          if (capturedFacts[assertion.field] === undefined) {
            failures.push(`Assertion failed: ${assertion.description || `Fact '${assertion.field}' must be present`}`);
          }
        } else if (assertion.type === 'budget_ceiling' && assertion.field) {
          const val = assertion.field.split('.').reduce((acc: any, part: string) => acc?.[part], capturedFacts);
          if (val === undefined || (assertion.expected !== undefined && val > assertion.expected)) {
            failures.push(`Assertion failed: ${assertion.description || `Field '${assertion.field}' must be <= ${assertion.expected}`}`);
          }
        }
      }

      const scenarioDuration = Date.now() - scenarioStart;
      scenarioResults.push({
        scenarioId: scenario.scenarioId,
        name: scenario.name,
        passed: failures.length === 0,
        finalStage,
        expectedStage: expectedStage || finalStage,
        capturedFacts,
        executedCapabilities: Array.from(executedCapabilitiesAcrossTurns),
        turns: turnsLog,
        failures,
        durationMs: scenarioDuration,
      });
    }

    const completedAt = new Date().toISOString();
    const durationMs = Date.now() - startTime;
    const passedScenarios = scenarioResults.filter((s) => s.passed).length;
    const failedScenarios = scenarioResults.filter((s) => !s.passed).length;
    const suitePassed = failedScenarios === 0;

    return {
      suiteId: suite.suiteId,
      tenantId,
      environmentId,
      passed: suitePassed,
      totalScenarios: scenarioResults.length,
      passedScenarios,
      failedScenarios,
      scenarios: scenarioResults,
      startedAt,
      completedAt,
      durationMs,
    };
  }

  /**
   * Executes a turn via explicit mode ('http' or 'in_process').
   * Never silently falls back between modes.
   */
  private async executeTurn(
    command: TurnCommand,
    release: BusinessPackRelease,
    mode: EvaluationExecutionMode,
    inProcessService?: any
  ): Promise<TurnResult> {
    if (mode === 'http') {
      const url = `${this.runtimeUrl}/api/v1/${command.tenantId}/${command.environmentId || 'production'}/runtime/turn`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 10000);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Tenant-ID': command.tenantId,
            'X-Environment-ID': command.environmentId || 'production',
          },
          body: JSON.stringify(command),
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(`HTTP turn returned status ${response.status}: ${body.slice(0, 200)}`);
        }
        return (await response.json()) as TurnResult;
      } catch (err: any) {
        clearTimeout(timeoutId);
        throw new Error(`[EvaluationRunner:HTTP] Turn execution failed over HTTP: ${err.message}`);
      }
    }

    if (!inProcessService) {
      throw new Error('[EvaluationRunner:InProcess] In-process service not initialized for this run');
    }
    return await inProcessService.executeTurn(command, release);
  }

  /**
   * Creates an isolated, uncached in-process TurnApplicationService instance
   * bound strictly to the current tenant and release candidate.
   *
   * Invariant: Never caches or reuses service across different tenants or releases.
   */
  private createInProcessService(
    release: BusinessPackRelease,
    options?: RunEvaluationOptions
  ): any {
    // Dynamic import from journey-runtime-service
    const { TurnApplicationService } = require('../../../apps/journey-runtime-service/src/kernel/turn-application.service');
    const { WorkspaceRepository } = require('../../../apps/journey-runtime-service/src/kernel/workspace.repository');
    const { WorkspaceStore } = require('../../../apps/journey-runtime-service/src/workspace/workspace.store');
    const { ExecutionRepository } = require('../../../apps/journey-runtime-service/src/kernel/execution.repository');
    const { OutboxRepository } = require('../../../apps/journey-runtime-service/src/kernel/outbox.repository');
    const { CapabilityGateway } = require('../../../apps/journey-runtime-service/src/kernel/capability.gateway');
    const { ApprovalService } = require('../../../apps/journey-runtime-service/src/kernel/approval.service');
    const { ApprovalStore } = require('../../../apps/journey-runtime-service/src/approval/approval.store');

    const packRepo = {
      loadActivePack: async () => release,
      hasActivePack: async () => true,
      invalidate: () => {},
    };

    let workspaceRepo = options?.repositories?.workspaceRepo;
    if (!workspaceRepo) {
      const workspaceStore = options?.isolatedDb
        ? new WorkspaceStore(options.isolatedDb)
        : new WorkspaceStore({ forceInMemory: true });
      workspaceRepo = new WorkspaceRepository(workspaceStore);
    }

    const executionRepo = options?.repositories?.executionRepo || new ExecutionRepository();

    let outboxRepo = options?.repositories?.outboxRepo;
    if (!outboxRepo) {
      outboxRepo = options?.isolatedDb
        ? new OutboxRepository(options.isolatedDb)
        : new OutboxRepository({ forceInMemory: true });
    }

    const capabilityGateway = options?.repositories?.capabilityGateway || new CapabilityGateway();

    const approvalStore = options?.isolatedDb
      ? new ApprovalStore(options.isolatedDb)
      : new ApprovalStore({ forceInMemory: true });
    const approvalService = new ApprovalService(approvalStore, outboxRepo);


    return new TurnApplicationService(
      packRepo,
      workspaceRepo,
      undefined,
      undefined,
      undefined,
      capabilityGateway,
      approvalService,
      executionRepo,
      outboxRepo
    );
  }
}
