import {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  Decision,
} from '@journeyax/journey-core';
import { BusinessPackLoader, BusinessPackRelease } from '@journeyax/business-pack';
import { CapabilityDispatcher, CapabilityResolver, ExecutionContext } from '@journeyax/capability-sdk';
import { WorkspaceStore } from '../workspace/workspace-store';
import { TurnInterpreter } from './interpret-event';
import { FactReducer } from './fact-reducer';
import { JourneyEngine } from '../journey/journey-engine';
import { OutcomeValidator } from './validate-outcome';
import { PresentationComposer } from './compose-response';
import {
  WorkwearSolutionOptimizerHandler,
  CatalogSearchHandler,
  PricingValidateHandler,
  OrderCommitHandler,
} from '../capabilities/handlers';
import * as path from 'path';

export class TurnRunner {
  private packLoader: BusinessPackLoader;
  private workspaceStore: WorkspaceStore;
  private interpreter: TurnInterpreter;
  private factReducer: FactReducer;
  private journeyEngine: JourneyEngine;
  private capabilityDispatcher: CapabilityDispatcher;
  private capabilityResolver: CapabilityResolver;
  private outcomeValidator: OutcomeValidator;
  private presentationComposer: PresentationComposer;

  constructor() {
    this.packLoader = new BusinessPackLoader({
      localPacksRoot: path.resolve(__dirname, '../../../../packs'),
    });
    this.workspaceStore = new WorkspaceStore();
    this.interpreter = new TurnInterpreter();
    this.factReducer = new FactReducer();
    this.journeyEngine = new JourneyEngine();
    this.capabilityDispatcher = new CapabilityDispatcher();
    this.capabilityResolver = new CapabilityResolver();
    this.outcomeValidator = new OutcomeValidator();
    this.presentationComposer = new PresentationComposer();

    // Register native capability handlers
    this.capabilityDispatcher.registerNativeHandler(
      'solution.optimize',
      new WorkwearSolutionOptimizerHandler()
    );
    this.capabilityDispatcher.registerNativeHandler(
      'catalog.search',
      new CatalogSearchHandler()
    );
    this.capabilityDispatcher.registerNativeHandler(
      'pricing.validate',
      new PricingValidateHandler()
    );
    this.capabilityDispatcher.registerNativeHandler(
      'order.commit',
      new OrderCommitHandler()
    );
  }

  /**
   * The single, unified turn execution pipeline for JourneyAX OS.
   * Every channel (Web, Mobile, WhatsApp, Stream, Batch) routes through here.
   */
  async runTurn(command: TurnCommand): Promise<TurnResult> {
    // 1. Resolve tenant and load exact published Business Pack release
    const release = await this.packLoader.loadPublished(
      command.tenantId,
      (command.environmentId as any) || 'production'
    );

    // 2. Load or initialize durable customer workspace
    let workspace = await this.workspaceStore.load(command.tenantId, command.workspaceId);
    if (!workspace) {
      const defaultJourney = release.journeys[0];
      workspace = this.workspaceStore.createInitial({
        tenantId: command.tenantId,
        workspaceId: command.workspaceId,
        packVersionId: release.manifest.version,
        journeyId: defaultJourney.journeyId,
        initialStage: defaultJourney.initialStage,
        goal: defaultJourney.goals[0] || 'resolve_solution',
      });
    }

    // 3. Extract intent and candidate facts using domain-neutral Business Pack vocabulary
    const interpretation = await this.interpreter.interpret(command, release, workspace);

    // 4. Reduce verified facts into the workspace
    let updatedWorkspace = this.factReducer.apply(workspace, interpretation);

    // 5. Evaluate journey state machine: stage transitions & missing facts
    let decision = this.journeyEngine.decide(release, updatedWorkspace);

    // If stage transition was decided, advance the stage and re-decide for the new stage
    if (decision.type === 'transition_stage' && decision.targetStage) {
      updatedWorkspace.currentStage = decision.targetStage;
      decision = this.journeyEngine.decide(release, updatedWorkspace);
    }

    // 6. Execute capability if decided
    let capabilityOutcome: any = null;
    if (decision.type === 'invoke_capability' && decision.targetCapability) {
      const toolDef = release.capabilities.toolDefinitions.find(
        (t: any) => t.toolId === decision.targetCapability
      );
      const toolBinding = release.capabilities.toolBindings.find(
        (b: any) => b.toolId === decision.targetCapability && b.tenantId === command.tenantId
      ) || release.capabilities.toolBindings.find(
        (b: any) => b.toolId === decision.targetCapability
      );

      if (toolDef && toolBinding) {
        const executionCtx: ExecutionContext = {
          tenantId: command.tenantId,
          environmentId: (command.environmentId as any) || 'production',
          workspaceId: command.workspaceId,
          sessionId: command.sessionId,
          principalId: command.principalId,
          stageId: updatedWorkspace.currentStage,
          packVersionId: release.manifest.version,
          correlationId: `corr_${Date.now()}`,
        };

        const execResponse = await this.capabilityDispatcher.dispatch(
          toolDef,
          toolBinding,
          {
            toolId: toolDef.toolId,
            input: decision.payload,
            userConfirmationConfirmed: true,
          },
          executionCtx
        );

        capabilityOutcome = execResponse.output;
      }
    }

    // 7. Validate outcome against deterministic business rules (e.g. Budget ceiling <= $250)
    const validatedOutcome = this.outcomeValidator.validate(
      decision,
      capabilityOutcome,
      release,
      updatedWorkspace
    );

    // 8. Compose structured UI instructions and grounded response
    const presentation = await this.presentationComposer.compose(
      validatedOutcome,
      decision,
      updatedWorkspace,
      release
    );

    // 9. Persist updated workspace state
    await this.workspaceStore.commit(updatedWorkspace);

    return presentation;
  }
}
