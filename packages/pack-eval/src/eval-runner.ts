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

export interface RunEvaluationOptions {
  tenantId: string;
  environmentId?: 'dev' | 'test' | 'staging' | 'production';
  runtimeUrl?: string;
  packDir?: string;
  release?: BusinessPackRelease;
  suitePath?: string;
  verbose?: boolean;
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
    process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';
    process.env.ALLOW_IN_MEMORY_OUTBOX = 'true';
    const startedAt = new Date().toISOString();
    const startTime = Date.now();
    const tenantId = options.tenantId;
    const environmentId = options.environmentId || 'production';

    // 1. Locate suite definition
    let suite: EvaluationSuite;
    if (options.suitePath && fs.existsSync(options.suitePath)) {
      suite = JSON.parse(fs.readFileSync(options.suitePath, 'utf8'));
    } else {
      const candidates = [
        path.resolve(process.cwd(), 'packs', tenantId, 'evaluations', `${tenantId}-acceptance.json`),
        path.resolve(process.cwd(), 'packs', tenantId, 'evaluations', `${tenantId}-evaluations.json`),
        path.resolve(process.cwd(), '..', '..', 'packs', tenantId, 'evaluations', `${tenantId}-acceptance.json`),
      ];
      const found = candidates.find((c) => fs.existsSync(c));
      if (!found) {
        throw new Error(
          `[EvaluationRunner] No evaluation suite found for tenant '${tenantId}'. Looked in: ${candidates.join(', ')}`
        );
      }
      suite = JSON.parse(fs.readFileSync(found, 'utf8'));
    }

    // 2. Load release candidate if not provided
    let release = options.release;
    if (!release) {
      const loader = new BusinessPackLoader();
      release = (await loader.loadFromDisk(tenantId, environmentId)) || undefined;
      if (!release) {
        throw new Error(
          `[EvaluationRunner] Failed to load Business Pack release for tenant '${tenantId}'`
        );
      }
    }

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
        try {
          res = await this.executeTurn(turnCmd, release);
        } catch (err: any) {
          failures.push(`Turn ${tIdx + 1} execution threw: ${err.message}`);
          break;
        }

        lastTurnResult = res;

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
   * Executes a turn via HTTP if runtime is up, otherwise via in-process TurnApplicationService.
   */
  private async executeTurn(command: TurnCommand, release: BusinessPackRelease): Promise<TurnResult> {
    const url = `${this.runtimeUrl}/api/v1/${command.tenantId}/${command.environmentId || 'production'}/runtime/turn`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1200);

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

      if (response.ok) {
        return (await response.json()) as TurnResult;
      }
    } catch {
      // Fallback to in-process execution below
    }

    // Direct in-process execution fallback
    return await this.executeInProcessTurn(command, release);
  }

  private inProcessServiceInstance: any = null;

  private async executeInProcessTurn(command: TurnCommand, release: BusinessPackRelease): Promise<TurnResult> {
    if (!this.inProcessServiceInstance) {
      process.env.NODE_ENV = 'test';
      process.env.ALLOW_IN_MEMORY_WORKSPACES = 'true';
      process.env.ALLOW_IN_MEMORY_OUTBOX = 'true';

      // Dynamic import from journey-runtime-service
      const { TurnApplicationService } = require('../../../apps/journey-runtime-service/src/kernel/turn-application.service');
      const { WorkspaceRepository } = require('../../../apps/journey-runtime-service/src/kernel/workspace.repository');
      const { WorkspaceStore } = require('../../../apps/journey-runtime-service/src/workspace/workspace.store');
      const { ExecutionRepository } = require('../../../apps/journey-runtime-service/src/kernel/execution.repository');
      const { OutboxRepository } = require('../../../apps/journey-runtime-service/src/kernel/outbox.repository');
      const { CapabilityGateway } = require('../../../apps/journey-runtime-service/src/kernel/capability.gateway');

      const packRepo = {
        loadActivePack: async () => release,
        hasActivePack: async () => true,
        invalidate: () => {},
      };

      const workspaceStore = new WorkspaceStore();
      const workspaceRepo = new WorkspaceRepository(workspaceStore);
      const executionRepo = new ExecutionRepository();
      const outboxRepo = new OutboxRepository();
      const capabilityGateway = new CapabilityGateway();

      this.inProcessServiceInstance = new TurnApplicationService(
        packRepo,
        workspaceRepo,
        undefined,
        undefined,
        undefined,
        capabilityGateway,
        undefined,
        executionRepo,
        outboxRepo
      );
    }

    return await this.inProcessServiceInstance.executeTurn(command, release);
  }
}
