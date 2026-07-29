/**
 * LLM provider registry — makes the back-office provider dropdown REAL.
 *
 * The per-project `ai.provider` (published config) selects the client. All
 * providers speak the OpenAI chat-completions protocol (native or via an
 * OpenAI-compatible endpoint):
 *   - openai    → api.openai.com                              (OPENAI_API_KEY)
 *   - anthropic → api.anthropic.com/v1/                       (ANTHROPIC_API_KEY)
 *   - gemini    → generativelanguage.googleapis.com/v1beta/openai/ (GEMINI_API_KEY)
 *   - ollama    → localhost:11434/v1                          (self-hosted, no key)
 *
 * KEY RESOLUTION (per project, then platform): a project may store its OWN api
 * key in the back office (`ai.apiKey`, secret-redacted at rest) — white-label
 * tenants bring their own billing. If a project has no key, we fall back to the
 * platform deployment env for that provider. A custom `ai.baseUrl` overrides the
 * endpoint (self-hosted / proxy / Azure-OpenAI style). Because the key/baseUrl
 * are now per-project, clients are cached by a composite key, not just provider.
 */
import OpenAI from 'openai';
import { createHash } from 'crypto';

export interface LlmClientConfig {
  provider?: string;
  /** Per-project key from config (already un-redacted via the internal-key fetch). */
  apiKey?: string;
  /** Optional endpoint override (self-hosted / proxy / gateway). */
  baseUrl?: string;
}

interface Resolved {
  baseURL?: string;
  apiKey: string;
  ok: boolean; // false → no key available anywhere (caller should degrade)
}

const clients = new Map<string, OpenAI>();

/** Resolve endpoint + key for a provider, preferring the project's own key. */
function resolve(provider: string, projectKey?: string, baseUrlOverride?: string): Resolved {
  const key = (name: string) => (projectKey && projectKey.trim()) || process.env[name] || '';
  switch (provider) {
    case 'anthropic': {
      const apiKey = key('ANTHROPIC_API_KEY');
      return { baseURL: baseUrlOverride || 'https://api.anthropic.com/v1/', apiKey, ok: !!apiKey };
    }
    case 'gemini':
    case 'google': {
      const apiKey = key('GEMINI_API_KEY');
      return {
        baseURL: baseUrlOverride || 'https://generativelanguage.googleapis.com/v1beta/openai/',
        apiKey,
        ok: !!apiKey,
      };
    }
    case 'ollama': {
      // Self-hosted: no real key needed, but honour an override if provided.
      return {
        baseURL: baseUrlOverride || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
        apiKey: (projectKey && projectKey.trim()) || process.env.OLLAMA_API_KEY || 'ollama',
        ok: true,
      };
    }
    case 'openai':
    default: {
      const apiKey = key('OPENAI_API_KEY');
      return { baseURL: baseUrlOverride, apiKey, ok: !!apiKey };
    }
  }
}

/**
 * Resolve just the endpoint + key for a project (no client), for callers that
 * speak a protocol the chat-completions SDK doesn't cover — e.g. the Responses
 * API with `web_search`, which school research uses. Same per-project-then-env
 * key resolution as the chat client, so research bills to the project's own key.
 * Returns a concrete base URL (OpenAI's default filled in) so callers can just
 * append `/responses`.
 */
export function resolveLlm(config?: LlmClientConfig): { baseURL: string; apiKey: string; ok: boolean; provider: string } {
  const provider = (config?.provider || 'openai').toLowerCase();
  const r = resolve(provider, config?.apiKey, config?.baseUrl);
  return { baseURL: (r.baseURL || 'https://api.openai.com/v1').replace(/\/$/, ''), apiKey: r.apiKey, ok: r.ok, provider };
}

/**
 * Get a chat client for a project's AI config. Accepts either a provider string
 * (back-compat) or the full `{ provider, apiKey, baseUrl }` config.
 */
export function getChatClient(config?: string | LlmClientConfig): OpenAI {
  const cfg: LlmClientConfig = typeof config === 'string' ? { provider: config } : config || {};
  const provider = (cfg.provider || 'openai').toLowerCase();

  const r = resolve(provider, cfg.apiKey, cfg.baseUrl);
  if (!r.ok) {
    // No key for the chosen provider anywhere → fall back to platform OpenAI so
    // the journey degrades gracefully instead of hard-failing on a mis-config.
    if (provider !== 'openai') {
      console.warn(`[llm/provider] provider="${provider}" has no API key (project or env) — falling back to OpenAI.`);
      return getChatClient('openai');
    }
  }

  // Cache by provider + endpoint + a collision-free key fingerprint (a hash, not
  // the raw key, and not a truncation that could collide across distinct keys).
  const fp = r.apiKey ? createHash('sha256').update(r.apiKey).digest('hex').slice(0, 16) : 'none';
  const cacheKey = `${provider}|${r.baseURL || 'default'}|${fp}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  const client = new OpenAI({
    ...(r.baseURL ? { baseURL: r.baseURL } : {}),
    apiKey: r.apiKey || 'missing',
  });
  clients.set(cacheKey, client);
  return client;
}
