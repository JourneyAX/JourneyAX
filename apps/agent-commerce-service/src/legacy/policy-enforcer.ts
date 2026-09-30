/**
 * @deprecated FROZEN LEGACY POLICY ENFORCER
 * Preserved strictly for unmigrated legacy tenants.
 * Canonical runtime uses published Business Pack policies and capabilities.
 */
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import { IntentResult, TraceEntry } from '../pipeline/types';
import { genParams } from '../llm/model-router';

@Injectable()
export class PolicyEnforcer {
  /**
   * Which UI tool or card this turn MUST emit so the right panel/card renders.
   */
  requiredUiTool(
    intent: IntentResult,
    opts: { customised?: boolean; capabilities?: string[] } = {}
  ): 'showItems' | 'showGuide' | 'showConfigurator' | null {
    if (intent.panelRenderBlocked) return null;
    const rt = intent.retrievalType;
    const productish =
      intent.stage === 'products' ||
      rt === 'product' ||
      rt === 'design' ||
      rt === 'collection';
    const canConfigure =
      !!opts.customised &&
      (!opts.capabilities?.length || opts.capabilities.includes('configurator'));
    if (productish && canConfigure) return 'showConfigurator';
    if (productish) return 'showItems';
    if (
      intent.stage === 'installation' ||
      rt === 'troubleshooting' ||
      rt === 'installation'
    ) {
      return 'showGuide';
    }
    return null;
  }

  /**
   * Force the model to emit a UI render tool using data already retrieved this turn.
   */
  async forceUiTool(
    tenantId: string,
    conversation: any[],
    activeTools: OpenAI.ChatCompletionTool[],
    toolName: 'showItems' | 'showGuide' | 'showConfigurator',
    uiToolCalls: any[],
    emit?: (event: string, data: any) => void,
    pushTrace?: (entry: TraceEntry) => void,
    llm?: OpenAI,
    model = 'gpt-4o-mini',
    projectConfig: any = {}
  ): Promise<void> {
    const targetTool = activeTools.find(
      (t) => t.type === 'function' && t.function.name === toolName
    );
    if (!targetTool) {
      console.warn(`[agent:forceUi] Tool ${toolName} not available in activeTools — cannot enforce`);
      return;
    }

    pushTrace?.({ step: 'force_ui', detail: `forcing ${toolName}` });
    const prompt =
      toolName === 'showConfigurator'
        ? `Render the configurator on the panel now so the customer can see and custom-design their piece. Call ${toolName} with the appropriate configuration based on the conversation.`
        : `Present the results on the customer's panel now. Call ${toolName} using ONLY products/guides already retrieved this turn. Do NOT invent new items.`;

    const forceMessages = [
      ...conversation,
      { role: 'user', content: prompt },
    ];

    try {
      const client = llm || new OpenAI();
      const fnName = (targetTool as any)?.function?.name || toolName;
      const res = await client.chat.completions.create({
        model,
        messages: forceMessages,
        tools: [targetTool],
        tool_choice: { type: 'function', function: { name: fnName } },
        ...genParams(model, projectConfig.temperature),
      });

      const choice = res.choices[0];
      const calls = choice?.message?.tool_calls || [];
      for (const call of calls) {
        const cFn = (call as any)?.function;
        if (cFn?.name === toolName) {
          uiToolCalls.push(call);
          emit?.('uiAction', {
            name: cFn.name,
            arguments: JSON.parse(cFn.arguments || '{}'),
          });
          conversation.push(choice.message);
          conversation.push({
            role: 'tool',
            tool_call_id: call.id,
            content: JSON.stringify({ rendered: true }),
          });
        }
      }
    } catch (err: any) {
      console.warn(`[agent:forceUi] Failed to force UI tool ${toolName}:`, err.message);
    }
  }

  /**
   * Evaluates if gender clarification is required before showing general items.
   */
  needsGenderFirst(intent: any, projectConfig: any, messages: any[]): boolean {
    const dims = (projectConfig?.contextDimensions || []) as any[];
    const g = dims.find((d) => String(d?.key || '').toLowerCase() === 'gender');
    const mustAsk =
      g && (g.scoping === true || g.scoping === 'must-ask' || g.mustAsk === true || g.required === true);
    if (!mustAsk) return false;
    if (intent?.dimensions?.gender) return false;
    const text = (messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => (typeof m?.content === 'string' ? m.content : ''))
      .join(' ')
      .toLowerCase();
    if (
      /\b(men|mens|man|male|women|womens|woman|female|kid|kids|boy|boys|girl|girls|son|daughter|his|her|hers)\b/.test(
        text
      )
    ) {
      return false;
    }
    return true;
  }

  /**
   * Generates synthetic gender clarification questions.
   */
  synthGenderClarify(intent: any): { name: string; arguments: any } {
    const qs: any[] = [
      { id: 'gender', title: 'Who are you shopping for?', options: ['Men', 'Women', 'Kids'] },
    ];
    if (!intent?.dimensions?.occasion) {
      qs.push({
        id: 'occasion',
        title: "What's the occasion?",
        options: ['Casual', 'Work', 'Date', 'Party', 'Vacation'],
      });
    }
    return { name: 'setPhase', arguments: { phase: 'clarify', questions: qs } };
  }

  /**
   * Filters out customisation / 3D vocabulary for plain retail stores.
   */
  stripCartTaboo(text: string, active: boolean): string {
    if (!text || !active) return text;
    const TABOO =
      /\b(customi[sz]\w*|non-?customi\w*|un-?customi\w*|personali[sz]\w*|design\s+lines?|3-?d\b|configurat\w*)\b|colou?rs?\s+are\s+fixed|fixed\s+colou?rs?/i;
    const parts = text.split(/(?<=[.!?])(\s+)/);
    let out = '';
    for (let i = 0; i < parts.length; i += 2) {
      const s = parts[i];
      const sep = parts[i + 1] ?? '';
      if (s && TABOO.test(s)) continue;
      out += s + sep;
    }
    let cleaned = out
      .replace(/[ \t]{2,}/g, ' ')
      .trim()
      .replace(/^(however|but|so|and|also|that said|in addition)[,\s]+/i, '');
    if (cleaned) cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
    return cleaned;
  }
}
