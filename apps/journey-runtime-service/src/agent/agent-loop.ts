import type {
  TurnCommand,
  TurnResult,
  WorkspaceState,
  Decision,
  UIInstruction,
} from '@journeyax/journey-core';
import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { OkfReleaseContent, ClaimClass } from '@journeyax/knowledge';
import {
  ModelGateway,
  type AgentMessage,
  type AgentToolCall,
} from '../kernel/model.gateway';
import {
  AGENT_TOOL_DEFINITIONS,
  executeAgentTool,
  isReadOnlyTool,
  type AgentToolContext,
} from './agent-tools';
import { formatBusinessProfile } from '../kernel/business-knowledge';
import { readHistory, appendHistory, formatHistoryBlock } from '../conversation';
import { sanitizeHistoryText } from '../conversation/history';
import { IncrementalSentenceShaper, type ShapeContext } from '../kernel/reply-shaper';
import { resolveTurnKind } from '../turn/turn-kind';
import { resolveInterpretationPolicy } from '../turn/fact-semantics';
import { CatalogSearchHandler } from '../capabilities/handlers/catalog-search.handler';
import { BranchStockCheckHandler } from '../capabilities/handlers/branch-stock-check.handler';
import { KnowledgeSearchHandler } from '../capabilities/handlers/knowledge-search.handler';
import type { KnowledgeControlPlanePort } from '../kernel/knowledge-control-plane';

export interface AgentTurnOptions {
  command: TurnCommand;
  release: BusinessPackRelease;
  workspace: WorkspaceState;
  modelGateway: ModelGateway;
  catalogSearchHandler: CatalogSearchHandler;
  branchStockHandler?: BranchStockCheckHandler;
  knowledgeSearchHandler?: KnowledgeSearchHandler;
  knowledgeControlPlane?: KnowledgeControlPlanePort;
  sink: (event: string, data: any) => void;
  maxToolRounds?: number;
  timeoutMs?: number;
}

export interface AgentTurnOutcome {
  turnResult: TurnResult;
  toolsCalled: Array<{ name: string; durationMs: number; ok: boolean; error?: string }>;
  okfNotesRead: string[];
  tokens: { prompt: number; completion: number; total: number };
  durationMs: number;
}

/**
 * Determines if agent mode is enabled for a given release or pack.
 * Agent mode is switched on per tenant by a pack setting (default off).
 */
export function isAgentModeEnabled(release?: any): boolean {
  if (!release) return false;
  const ext = release.extensions;
  if (ext?.agentMode?.enabled === true || ext?.agentMode === true) return true;
  if (ext?.dialoguePolicy?.agentMode === true) return true;
  return false;
}

const SYSTEM_PROMPT_TEMPLATE = `You are the official conversational AI consultant for this merchant.
Your mission is to help customers find products, plan trade and DIY projects, explain correct installation, and ensure they have the complete system they need.

Core Principles:
1. Be concise, direct, helpful, and natural.
2. Grounding Rules:
   - Statements about prices, stock availability, compliance marks, building code adherence, and warranties MUST be grounded in tool results from this turn.
   - Never invent or assume prices or stock. If you have not looked up a product with a tool, do so before making factual claims about it.
3. Journey Playbook Advice:
   - Understand the job: Clarify the customer's goal or project context when needed.
   - Ask only what is needed: Keep clarifying questions focused.
   - Recommend: Offer specific, high-fit products from the catalogue with a clear reason.
   - Complete the system: Check for matching accessories, fixings, fasteners, and installation materials (using consult_business_knowledge or get_related_products) so the customer does not leave with an incomplete system.
   - Explain installation: Provide concise guidance from verified guides.
   - State warranties clearly: When asked, cite exact warranty terms and sources.
   - Offer the next step: Guide the customer to quotes, cart, or specialist consultation.
4. UI Cards (UI As a Tool):
   - Choose interactive cards using present_card from the approved card types: products, productDetail, comparison, bundle, clarify, accessories, warranty, guide, plan.
   - NEVER output raw HTML or invent custom card types.
   - Every product SKU referenced on a card MUST have been returned by a tool result in this turn. Always call search_products or get_product first before presenting a product card.
   - Product prices and stock on cards are filled in by the server from the catalogue data.
5. Scope:
   - If a customer asks for items or services explicitly not sold (see What is NOT sold in the business profile), politely explain the merchant does not sell those items and offer human assistance if appropriate.`;

export class AgentTurnLoop {
  /**
   * Executes the full multi-round agent loop with streaming and claim validation.
   */
  async execute(options: AgentTurnOptions): Promise<AgentTurnOutcome> {
    const {
      command,
      release,
      workspace,
      modelGateway,
      catalogSearchHandler,
      branchStockHandler,
      knowledgeSearchHandler,
      knowledgeControlPlane,
      sink = () => {},
      maxToolRounds = 5,
    } = options;

    const loopStart = Date.now();
    const customerQuestion = (
      command.message ||
      (command as any).userInput ||
      (command as any).text ||
      ''
    ).trim();

    // 1. Resolve pinned OKF release content for business profile and knowledge tools
    let okfContent: OkfReleaseContent | null = null;
    if (release.knowledgeModel?.type === 'okf_release' && knowledgeControlPlane?.getReleaseContent) {
      try {
        okfContent = await knowledgeControlPlane.getReleaseContent(
          command.tenantId,
          command.environmentId || 'production',
          release.knowledgeModel
        );
      } catch {
        // Non-blocking if OKF release loading fails
      }
    }

    // 2. Prepare Tool Context (server-enforced tenant isolation)
    const toolContext: AgentToolContext = {
      tenantId: command.tenantId,
      environmentId: (command.environmentId as any) || 'production',
      workspaceId: command.workspaceId || command.sessionId,
      sessionId: command.sessionId || command.workspaceId,
      correlationId: command.correlationId || `corr-${Date.now()}`,
      release,
      okfContent,
      catalogSearchHandler,
      branchStockHandler,
      knowledgeSearchHandler,
      knowledgeControlPlane,
      turnProductSkus: new Set<string>(),
      catalogProductCache: new Map<string, any>(),
      readSourceIds: new Set<string>(),
      allowedClaimClasses: new Set<ClaimClass>(),
      presentedCards: [],
      isHumanHandoffRequested: false,
      emitUiAction: (action) => sink('uiAction', action),
      emitTrace: (name, payload) => sink('trace', { [name]: payload }),
    };

    // 3. Build System Prompt & Business Profile (stable and cacheable)
    const businessProfileBlock = formatBusinessProfile(release, okfContent);
    const systemPrompt = `${SYSTEM_PROMPT_TEMPLATE}\n\n${businessProfileBlock}`;

    // 4. Build Messages (Conversation History + New Customer Message)
    const messages: AgentMessage[] = [];

    // History from Phase 1
    const pastTurns = readHistory(workspace?.facts);
    if (pastTurns.length > 0) {
      const historyText = formatHistoryBlock(pastTurns);
      messages.push({
        role: 'user',
        content: `[Previous Conversation History]\n${historyText}`,
      });
      messages.push({
        role: 'assistant',
        content: 'I understand the conversation history and will use it to interpret follow-up questions in context.',
      });
    }

    // Current Customer Message (escaped data block)
    const sanitizedCustomer = sanitizeHistoryText(customerQuestion);
    messages.push({
      role: 'user',
      content: `<customer_message>\n${sanitizedCustomer}\n</customer_message>`,
    });

    // 5. Reply Shaper & Claim Guard Setup
    const interpPolicy = resolveInterpretationPolicy(release);
    const baseStyle = interpPolicy.replyStyle || {
      maxSentences: 3,
      dropListLines: false,
      dropCompanyName: false,
      forbiddenPhrases: [],
      rules: [],
    };

    const tempDecision: Decision = {
      decisionId: `temp_${Date.now()}`,
      type: 'complete_goal',
      payload: {},
      reason: 'Evaluating initial turn kind',
      createdAt: new Date().toISOString(),
    };

    const turnKind = resolveTurnKind({
      customerQuestion,
      decision: tempDecision,
    });

    const shapeContext: ShapeContext = {
      style: baseStyle,
      companyNames: [release.profile?.companyName || release.manifest?.name || ''].filter(Boolean),
      internalIds: [],
      questionCardShown: false,
      turnKind,
    };

    const toolsTrace: Array<{ name: string; durationMs: number; ok: boolean; error?: string }> = [];
    const totalTokens = { prompt: 0, completion: 0, total: 0 };
    let finalAssistantText = '';
    let isFinished = false;

    // 6. Multi-Round Tool Loop (at most 5 rounds)
    for (let round = 0; round < maxToolRounds; round++) {
      if (isFinished) break;

      let roundContent = '';
      let roundToolCalls: AgentToolCall[] = [];

      // Determine if this is the final text-generation phase
      const isLastAllowedRound = round === maxToolRounds - 1;

      // Stream delta handler
      const deltaChunks: string[] = [];
      const onDelta = (delta: string) => {
        deltaChunks.push(delta);
      };

      const response = await modelGateway.executeAgentStream(
        release,
        {
          taskType: 'agent_turn',
          systemPrompt,
          messages,
          tools: isLastAllowedRound ? undefined : AGENT_TOOL_DEFINITIONS,
          policyRef: 'agent_turn',
        },
        onDelta
      );

      if (response.usage) {
        totalTokens.prompt += response.usage.promptTokens || 0;
        totalTokens.completion += response.usage.completionTokens || 0;
        totalTokens.total += response.usage.totalTokens || 0;
      }

      roundContent = response.content;
      roundToolCalls = response.toolCalls || [];

      // If the model called tools
      if (roundToolCalls.length > 0) {
        // Emit capability traces to sink (for UI WorkingStrip)
        for (const tc of roundToolCalls) {
          sink('capability', { toolId: tc.name, callId: tc.id });
        }

        // Add assistant message containing the tool calls
        messages.push({
          role: 'assistant',
          content: roundContent || undefined,
          tool_calls: roundToolCalls,
        });

        // Partition tools into read-only and mutating
        const readOnlyCalls = roundToolCalls.filter((tc) => isReadOnlyTool(tc.name));
        const mutatingCalls = roundToolCalls.filter((tc) => !isReadOnlyTool(tc.name));

        // Execute read-only tools in parallel
        const readOnlyResults = await Promise.all(
          readOnlyCalls.map(async (tc) => {
            const toolStart = Date.now();
            let result: any;
            let ok = true;
            try {
              result = await executeAgentTool(tc.name, tc.arguments, toolContext);
              if (result && typeof result === 'object' && result.ok === false) {
                ok = false;
              }
            } catch (err: any) {
              ok = false;
              result = { ok: false, error: `Tool execution failed: ${err.message}` };
            }
            const durationMs = Date.now() - toolStart;
            toolsTrace.push({ name: tc.name, durationMs, ok, error: !ok ? result?.error : undefined });
            return { call: tc, result };
          })
        );

        // Execute mutating tools in sequence (e.g. present_card, hand_off_to_human)
        const mutatingResults: Array<{ call: AgentToolCall; result: any }> = [];
        for (const tc of mutatingCalls) {
          const toolStart = Date.now();
          let result: any;
          let ok = true;
          try {
            result = await executeAgentTool(tc.name, tc.arguments, toolContext);
            if (result && typeof result === 'object' && result.ok === false) {
              ok = false;
            }
          } catch (err: any) {
            ok = false;
            result = { ok: false, error: `Tool execution failed: ${err.message}` };
          }
          const durationMs = Date.now() - toolStart;
          toolsTrace.push({ name: tc.name, durationMs, ok, error: !ok ? result?.error : undefined });
          mutatingResults.push({ call: tc, result });
        }

        // Append tool results to messages
        for (const { call, result } of [...readOnlyResults, ...mutatingResults]) {
          messages.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.name,
            content: typeof result === 'string' ? result : JSON.stringify(result),
          });
        }

        // If human handoff was requested, we can conclude
        if (toolContext.isHumanHandoffRequested) {
          isFinished = true;
          finalAssistantText = 'A customer consultant has been notified and will assist you shortly.';
          sink('token', { delta: finalAssistantText });
          break;
        }
      } else {
        // No tool calls returned: this is the final customer-facing answer
        isFinished = true;

        // Process generated text through OKF Claim Guard and Reply Shaper (always active in agent mode)
        const shaper = new IncrementalSentenceShaper(
          shapeContext,
          Array.from(toolContext.allowedClaimClasses),
          true,
          (_sentence, delta) => {
            sink('token', { delta });
          }
        );

        // Process all streamed or response text chunks
        if (deltaChunks.length > 0) {
          for (const chunk of deltaChunks) {
            shaper.processDelta(chunk);
          }
        } else if (roundContent) {
          shaper.processDelta(roundContent);
        }

        shaper.flush();
        finalAssistantText = shaper.getStreamedText().trim();

        // If all sentences were withheld by claim guard (or empty text)
        if (!finalAssistantText) {
          const fallback =
            'I want to ensure all details and specifications are completely accurate. Would you like me to connect you with a specialist consultant who can verify this for you?';
          sink('token', { delta: fallback });
          finalAssistantText = fallback;
        }

        break;
      }
    }

    // 7. Determine Final Decision
    let decision: Decision;
    if (toolContext.isHumanHandoffRequested) {
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'handoff',
        payload: { reason: toolContext.handoffReason },
        reason: toolContext.handoffReason || 'Handoff requested',
        createdAt: new Date().toISOString(),
      };
    } else {
      decision = {
        decisionId: `dec_${Date.now()}`,
        type: 'complete_goal',
        payload: { answer: finalAssistantText },
        reason: 'Agent provided grounded answer',
        createdAt: new Date().toISOString(),
      };
    }

    // 8. Update Workspace Conversation History
    appendHistory(
      workspace,
      [
        { role: 'customer', content: customerQuestion, turnId: command.turnId },
        { role: 'assistant', content: finalAssistantText, turnId: command.turnId },
      ],
      release.extensions?.dialoguePolicy?.history
    );

    const totalDurationMs = Date.now() - loopStart;

    const uiInstructions: UIInstruction[] = toolContext.presentedCards.map((c) => ({
      component: c.cardType,
      props: c.state,
      envelope: {
        name: 'presentCard',
        arguments: {
          card: {
            id: `${c.cardType}-${Date.now()}`,
            cardType: c.cardType,
            state: c.state,
          },
        },
      },
    }));

    const turnResult: TurnResult = {
      workspace,
      decision,
      assistantMessage: finalAssistantText,
      uiInstructions,
      executedCapabilities: toolsTrace.map((t) => ({
        toolId: t.name,
        input: {},
        output: {},
        status: t.ok ? 'success' : 'failure',
        durationMs: t.durationMs,
      })),
      trace: {
        agentMode: true,
        toolsCalled: toolsTrace,
        readSourceIds: Array.from(toolContext.readSourceIds),
        toolProductSkus: Array.from(toolContext.turnProductSkus),
        allowedClaimClasses: Array.from(toolContext.allowedClaimClasses),
        tokens: totalTokens,
        durationMs: totalDurationMs,
      } as any,
    };

    return {
      turnResult,
      toolsCalled: toolsTrace,
      okfNotesRead: Array.from(toolContext.readSourceIds),
      tokens: totalTokens,
      durationMs: totalDurationMs,
    };
  }
}
