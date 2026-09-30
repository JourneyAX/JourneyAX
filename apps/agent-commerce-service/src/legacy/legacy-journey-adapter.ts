import { Injectable, Inject, Optional } from '@nestjs/common';
import { ConfigLoader } from '../pipeline/config-loader';
import { SessionStore } from '../pipeline/session-store';
import { ModelRouter } from '../llm/model-router';
import { PolicyEnforcer } from './policy-enforcer';
import { StorefrontCommerceService } from '../commerce/storefront-commerce.service';
import { ResponseComposer } from '../presentation/response-composer';
import { ToolDispatcher } from './tool-dispatcher';
import { QuoteService } from '../commerce/quote.service';
import {
  ChatRequest,
  ChatResponse,
} from '../pipeline/types';

/**
 * @deprecated FROZEN LEGACY JOURNEY ADAPTER
 * This adapter is preserved strictly for unmigrated tenants (Caroma, Abercrombie, Workwear).
 * Active Business Pack tenants (such as PlaceMakers) must NEVER execute this adapter.
 * Scheduled for decommissioning once each tenant completes its migration gate.
 */
@Injectable()
export class LegacyJourneyAdapter {
  constructor(
    @Optional() @Inject(ConfigLoader) private readonly configLoader: ConfigLoader = new ConfigLoader(),
    @Optional() @Inject(SessionStore) private readonly sessions: SessionStore = new SessionStore(),
    @Optional() @Inject(ModelRouter) private readonly modelRouter: ModelRouter = new ModelRouter(),
    @Optional() @Inject(PolicyEnforcer) private readonly policyEnforcer: PolicyEnforcer = new PolicyEnforcer(),
    @Optional() @Inject(StorefrontCommerceService) private readonly storefrontCommerce: StorefrontCommerceService = new StorefrontCommerceService(),
    @Optional() @Inject(ResponseComposer) private readonly composer: ResponseComposer = new ResponseComposer(),
    @Optional() @Inject(ToolDispatcher) private readonly toolDispatcher: ToolDispatcher = new ToolDispatcher(),
    @Optional() @Inject(QuoteService) private readonly quoteService: QuoteService = new QuoteService()
  ) {}

  /**
   * One shared legacy turn executor used by both buffered and SSE paths.
   *
   * Invariants:
   * 1. Supplies configured tools in both paths.
   * 2. In SSE path, accumulates streamed tool-call deltas by chunk index.
   * 3. Executes tool calls via the legacy ToolDispatcher.
   * 4. Appends assistant tool calls and role=tool results to the conversation.
   * 5. Continues model execution until a final assistant response or bounded loop limit.
   * 6. Emits identical UI actions and cards for both buffered and SSE requests.
   * 7. Persists full conversation state to SessionStore.
   */
  async executeLegacyTurn(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<ChatResponse> {
    const tenantId = (request.tenantId || '').toLowerCase().trim();
    if (!tenantId) {
      throw new Error('[LegacyJourneyAdapter] Missing tenantId - failing closed: tenantId is required');
    }

    const sessionId = request.sessionId || `legacy_${Date.now()}`;
    const projectConfig = await this.configLoader.loadProjectConfig(tenantId);
    if (!projectConfig) {
      throw new Error(`[LegacyJourneyAdapter] No active configuration found for tenant "${tenantId}" - failing closed`);
    }

    // Require configured model; fail closed without generic fallbacks
    if (!projectConfig.model || !projectConfig.model.trim()) {
      throw new Error(`[LegacyJourneyAdapter] Tenant "${tenantId}" missing required configured model - failing closed`);
    }
    const model = projectConfig.model.trim();

    // Require configured systemPromptOverrides; fail closed without generic fallbacks
    if (!projectConfig.systemPromptOverrides || !projectConfig.systemPromptOverrides.trim()) {
      throw new Error(`[LegacyJourneyAdapter] Tenant "${tenantId}" missing required systemPromptOverrides - failing closed`);
    }

    // Preserve conversation state from durable/in-memory session store
    const existingSession = await this.sessions.load(sessionId, tenantId);
    const history = existingSession?.messages || [];
    const incoming: any[] = request.messages && request.messages.length
      ? [...request.messages]
      : request.message
      ? [{ role: 'user', content: request.message }]
      : [];
    const messages = [...history, ...incoming];

    const activeTools = this.toolDispatcher.buildToolset({
      enabledCapabilities: projectConfig?.capabilities,
      closing: projectConfig?.commerceMode === 'cart' ? 'bag' : 'quote',
    });

    const rules = (await this.configLoader.loadActiveRules?.(tenantId)) || [];
    const brandHub = await this.configLoader.loadBrandHub?.(tenantId);
    const rulesBlock = this.configLoader.renderRulesBlock ? this.configLoader.renderRulesBlock(rules) : '';
    const brandHubBlock = this.configLoader.renderBrandHubBlock ? this.configLoader.renderBrandHubBlock(brandHub) : '';

    const systemPromptParts = [
      projectConfig.systemPromptOverrides,
      projectConfig.journeyGuidance,
      rulesBlock,
      brandHubBlock,
    ].filter(Boolean);
    const systemPrompt = systemPromptParts.join('\n\n');

    const conversationMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...messages,
    ];

    const turnUiActions: Array<{ name: string; arguments: any }> = [];
    const MAX_TURNS = 5;

    if (emit) {
      emit('session', { sessionId });
    }

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      if (emit) {
        // Streaming path
        const stream = await this.modelRouter.createChatCompletionStream(
          conversationMessages,
          activeTools.length ? activeTools : undefined,
          {
            model,
            apiKey: projectConfig.apiKey,
            baseUrl: projectConfig.baseUrl,
            provider: projectConfig.provider,
          }
        );

        let assistantContent = '';
        const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();

        for await (const chunk of stream) {
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) {
            assistantContent += delta.content;
            emit('token', { token: delta.content, delta: delta.content });
          }
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              const idx = tc.index ?? 0;
              const existing = toolCallsMap.get(idx) || { id: '', name: '', arguments: '' };
              if (tc.id) existing.id = tc.id;
              if (tc.function?.name) existing.name += tc.function.name;
              if (tc.function?.arguments) existing.arguments += tc.function.arguments;
              toolCallsMap.set(idx, existing);
            }
          }
        }

        const completedToolCalls = Array.from(toolCallsMap.values()).filter((tc) => tc.name);
        if (completedToolCalls.length > 0) {
          // Ensure generated tool-call ID is preserved consistently on the object
          completedToolCalls.forEach((tc, i) => {
            if (!tc.id) {
              tc.id = `call_${Date.now()}_${i}`;
            }
          });

          conversationMessages.push({
            role: 'assistant',
            content: assistantContent || null,
            tool_calls: completedToolCalls.map((tc) => ({
              id: tc.id,
              type: 'function',
              function: {
                name: tc.name,
                arguments: tc.arguments,
              },
            })),
          });

          for (const tc of completedToolCalls) {
            const toolRes = await this.toolDispatcher.executeTool(tc.name, tc.arguments, {
              tenantId,
              intent: {
                intent: 'chat',
                stage: 'dialogue',
                mode: 'business',
                needsRetrieval: false,
                confidence: 1.0,
                missingInfo: [],
              },
              projectConfig,
              quoteService: this.quoteService,
            });

            const actions = this.mapToolResultToUiActions(tc.name, toolRes);
            for (const act of actions) {
              turnUiActions.push(act);
              emit('uiAction', act);
              if (act.arguments?.card) {
                emit('card', act.arguments.card);
              }
            }

            conversationMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof toolRes === 'string' ? toolRes : JSON.stringify(toolRes),
            });
          }

          continue; // Loop to generate follow-up explanation after tool execution
        } else {
          conversationMessages.push({
            role: 'assistant',
            content: assistantContent,
          });
          break;
        }
      } else {
        // Buffered path
        const completion = await this.modelRouter.createChatCompletion(
          conversationMessages,
          activeTools.length ? activeTools : undefined,
          {
            model,
            apiKey: projectConfig.apiKey,
            baseUrl: projectConfig.baseUrl,
            provider: projectConfig.provider,
          }
        );

        const assistantMsg = completion.choices?.[0]?.message;
        const content = assistantMsg?.content || '';

        if (assistantMsg?.tool_calls && assistantMsg.tool_calls.length > 0) {
          // Ensure generated tool-call ID is preserved consistently on each tool-call object
          (assistantMsg.tool_calls as any[]).forEach((tc: any, i: number) => {
            if (!tc.id) {
              tc.id = `call_${Date.now()}_${i}`;
            }
          });

          conversationMessages.push(assistantMsg);

          for (const tc of assistantMsg.tool_calls as any[]) {
            const toolName = tc.function?.name || tc.name;
            const toolArgs = tc.function?.arguments || tc.arguments;
            if (!toolName) continue;

            const toolRes = await this.toolDispatcher.executeTool(toolName, toolArgs, {
              tenantId,
              intent: {
                intent: 'chat',
                stage: 'dialogue',
                mode: 'business',
                needsRetrieval: false,
                confidence: 1.0,
                missingInfo: [],
              },
              projectConfig,
              quoteService: this.quoteService,
            });

            const actions = this.mapToolResultToUiActions(toolName, toolRes);
            for (const act of actions) {
              turnUiActions.push(act);
            }

            conversationMessages.push({
              role: 'tool',
              tool_call_id: tc.id,
              content: typeof toolRes === 'string' ? toolRes : JSON.stringify(toolRes),
            });
          }

          continue;
        } else {
          conversationMessages.push({
            role: 'assistant',
            content,
          });
          break;
        }
      }
    }

    const lastAssistantMsg = [...conversationMessages].reverse().find((m) => m.role === 'assistant');
    const finalContent = this.composer.stripChatMedia(lastAssistantMsg?.content || '');

    // Save session state
    await this.sessions.save({
      sessionId,
      tenantId,
      messages: conversationMessages,
    });

    if (emit) {
      emit('data', {
        sessionId,
        message: { role: 'assistant', content: finalContent },
        uiActions: turnUiActions,
      });
      emit('done', {});
    }

    return {
      message: { role: 'assistant', content: finalContent },
      conversation: conversationMessages,
      uiActions: turnUiActions,
      sessionId,
    };
  }

  async executeLegacyChat(request: ChatRequest): Promise<ChatResponse> {
    return this.executeLegacyTurn(request);
  }

  async executeLegacyChatStream(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<void> {
    await this.executeLegacyTurn(request, emit);
  }

  private mapToolResultToUiActions(
    toolName: string,
    toolRes: any
  ): Array<{ name: string; arguments: any }> {
    const uiActions: Array<{ name: string; arguments: any }> = [];
    if (toolName === 'openSpacePlanner' || toolName === 'spacePlanner.open') {
      uiActions.push({
        name: 'openSpacePlanner',
        arguments: toolRes,
      });
    } else if (toolName === 'showItems' || toolName === 'products.present') {
      uiActions.push({
        name: 'showItems',
        arguments: toolRes,
      });
    } else if (toolName === 'showGuide' || toolName === 'guide.present') {
      uiActions.push({
        name: 'showGuide',
        arguments: toolRes,
      });
    } else if (toolName === 'updateQuote' || toolName === 'trade.quote_create') {
      uiActions.push({
        name: 'presentCard',
        arguments: {
          card: {
            id: `quote-${Date.now()}`,
            cardType: 'quote_summary_card',
            state: toolRes,
          },
        },
      });
    } else if (toolRes?.card || toolRes?.component) {
      uiActions.push({
        name: 'presentCard',
        arguments: {
          card: toolRes.card || {
            id: `card-${Date.now()}`,
            cardType: toolRes.component,
            state: toolRes.props || toolRes,
          },
        },
      });
    }
    return uiActions;
  }
}
