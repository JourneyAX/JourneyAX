/**
 * The model the care desk uses, from the project's own published settings (its provider, model and key), so the same key and the same bill as the
 * assistant. One question in, one JSON answer out; any failure returns null and the processor falls back to plain words, so a model outage never
 * stops a ticket reaching a person.
 */
import { ConfigLoader } from '../pipeline/config-loader';
import { getChatClient } from '../llm/provider';
import type { CareModel } from './care.processor';

export class LlmCareModel implements CareModel {
  private readonly configs = new ConfigLoader();
  /** Calls made since the service started, so the cost of the work is visible in the logs. */
  calls = 0;
  tokens = 0;

  constructor(private readonly log: (message: string) => void = () => {}) {}

  async json(system: string, user: string, tenantId = 'placemakers'): Promise<any | null> {
    try {
      const cfg: any = await this.configs.loadProjectConfig(tenantId).catch(() => null);
      const model: string | undefined = process.env.CARE_MODEL || cfg?.model;
      if (!model) return null;
      const client = getChatClient({ provider: cfg?.provider, apiKey: cfg?.apiKey, baseUrl: cfg?.baseUrl });
      const reasoning = /^(gpt-5|o[134])/.test(model);
      const messages = [
        { role: 'system' as const, content: `${system}\n\nReply with ONE JSON object and nothing else: no prose, no code fence.` },
        { role: 'user' as const, content: user },
      ];
      let res;
      try { res = await client.chat.completions.create({ model, messages, response_format: { type: 'json_object' }, ...(reasoning ? {} : { temperature: 0 }) }); }
      catch { res = await client.chat.completions.create({ model, messages, ...(reasoning ? {} : { temperature: 0 }) }); }
      this.calls += 1; this.tokens += Number(res.usage?.total_tokens) || 0;
      this.log(`care: model call ${this.calls} (${res.usage?.total_tokens ?? '?'} tokens, ${this.tokens} in all)`);
      const out = String(res.choices[0]?.message?.content || '');
      const a = out.indexOf('{'); const b = out.lastIndexOf('}');
      return JSON.parse(a >= 0 && b > a ? out.slice(a, b + 1) : out);
    } catch (error: any) {
      this.log(`care: the model could not be used (${String(error?.message || error).slice(0, 120)}); using plain words`);
      return null;
    }
  }
}
