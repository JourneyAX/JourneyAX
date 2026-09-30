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
import { GoogleAuth } from 'google-auth-library';

let cachedGcpToken: { token: string; expiresAt: number; audience: string } | null = null;

/**
 * A service-account-backed ID token client, keyed by the key file so a config
 * change (or the same process outliving a key rotation) doesn't reuse a stale
 * client. `google-auth-library` reads `GOOGLE_APPLICATION_CREDENTIALS` itself
 * via Application Default Credentials — no argument needed.
 */
let cachedAuthClient: { keyPath: string; promise: Promise<import('google-auth-library').IdTokenClient> } | null = null;

async function getServiceAccountIdToken(targetAudience: string): Promise<string> {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!keyPath) return '';
  try {
    if (!cachedAuthClient || cachedAuthClient.keyPath !== keyPath) {
      cachedAuthClient = { keyPath, promise: new GoogleAuth().getIdTokenClient(targetAudience) };
    }
    const client = await cachedAuthClient.promise;
    return (await client.idTokenProvider.fetchIdToken(targetAudience)) || '';
  } catch (e: any) {
    console.warn('[llm/provider] service-account ID token fetch failed:', e.message);
    return '';
  }
}

/** Obtain Google Cloud identity token for service-to-service Cloud Run authentication. */
async function getGcpIdentityToken(targetAudience: string): Promise<string> {
  const now = Date.now();
  if (cachedGcpToken && cachedGcpToken.audience === targetAudience && cachedGcpToken.expiresAt > now + 60_000) {
    return cachedGcpToken.token;
  }

  // 1. Running inside GCP Cloud Run (Metadata service) — the real production path.
  try {
    const res = await fetch(`http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(targetAudience)}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(1200),
    });
    if (res.ok) {
      const token = (await res.text()).trim();
      cachedGcpToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
      return token;
    }
  } catch {
    // Non-GCP runtime
  }

  // 2. Dedicated service account key (local dev / non-GCP host).
  {
    const token = await getServiceAccountIdToken(targetAudience);
    if (token) {
      cachedGcpToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
      return token;
    }
  }

  // 3. Explicit environment variable override (environment-neutral provider interface)
  if (process.env.GCP_ID_TOKEN || process.env.CLOUD_RUN_ID_TOKEN) {
    const token = (process.env.GCP_ID_TOKEN || process.env.CLOUD_RUN_ID_TOKEN)!.trim();
    cachedGcpToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
    return token;
  }

  return '';
}

export interface LlmClientConfig {
  provider?: string;
  /** Per-project key from config (already un-redacted via the internal-key fetch). */
  apiKey?: string;
  /** Optional endpoint override (self-hosted / proxy / gateway). */
  baseUrl?: string;
  /** Explicit fallback provider if declared in model policy */
  fallbackProvider?: string;
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
    case 'open-model':
    case 'custom': {
      const apiKey = key('OPEN_MODEL_API_KEY');
      const baseURL = baseUrlOverride || process.env.OPEN_MODEL_BASE_URL;
      return {
        baseURL,
        apiKey: apiKey || '',
        ok: !!baseURL,
      };
    }
    case 'ollama': {
      const apiKey = key('OLLAMA_API_KEY');
      return {
        baseURL: baseUrlOverride || process.env.OLLAMA_BASE_URL || 'http://localhost:11434/v1',
        apiKey: apiKey || 'ollama',
        ok: true,
      };
    }
    case 'openai': {
      const apiKey = key('OPENAI_API_KEY');
      return { baseURL: baseUrlOverride, apiKey, ok: !!apiKey };
    }
    default: {
      return { baseURL: baseUrlOverride, apiKey: '', ok: false };
    }
  }
}

/**
 * Resolve just the endpoint + key for a project (no client), for callers that
 * speak a protocol the chat-completions SDK doesn't cover — e.g. the Responses
 * API with `web_search`, which school research uses.
 */
export function resolveLlm(config?: LlmClientConfig): { baseURL: string; apiKey: string; ok: boolean; provider: string } {
  const provider = (config?.provider || 'openai').toLowerCase();
  const r = resolve(provider, config?.apiKey, config?.baseUrl);
  if (!r.ok) {
    throw new Error(`[llm/provider] Provider "${provider}" is not configured or missing credentials.`);
  }
  return { baseURL: (r.baseURL || 'https://api.openai.com/v1').replace(/\/$/, ''), apiKey: r.apiKey, ok: r.ok, provider };
}

/**
 * Get a chat client for a project's AI config. Accepts either a provider string
 * (back-compat) or the full `{ provider, apiKey, baseUrl }` config.
 * Never silently falls back to OpenAI unless explicitly configured in model policy.
 */
export function getChatClient(config?: string | LlmClientConfig): OpenAI {
  const cfg: LlmClientConfig = typeof config === 'string' ? { provider: config } : config || {};
  const provider = (cfg.provider || 'openai').toLowerCase();

  const r = resolve(provider, cfg.apiKey, cfg.baseUrl);
  if (!r.ok) {
    if (cfg.fallbackProvider) {
      console.warn(`[llm/provider] Provider "${provider}" unconfigured — falling back to declared fallback "${cfg.fallbackProvider}"`);
      return getChatClient({ ...cfg, provider: cfg.fallbackProvider, fallbackProvider: undefined });
    }
    throw new Error(
      `[llm/provider] Provider "${provider}" has no API credentials configured (implicit fallback to OpenAI is prohibited).`
    );
  }

  // Cache by provider + endpoint + a collision-free key fingerprint (a hash, not
  // the raw key, and not a truncation that could collide across distinct keys).
  const fp = r.apiKey ? createHash('sha256').update(r.apiKey).digest('hex').slice(0, 16) : 'none';
  const cacheKey = `${provider}|${r.baseURL || 'default'}|${fp}`;
  const cached = clients.get(cacheKey);
  if (cached) return cached;

  // A reasoning model (gpt-5) with a long journeyGuidance system prompt and a
  // full tool schema can legitimately take well over 60s to produce a single
  // completion — at maxRetries:2 the SDK was silently retrying a merely-slow
  // call, restarting the same expensive reasoning from scratch each time and
  // compounding a ~70s wait into a 150-180s customer-facing hang. Widening the
  // per-attempt budget and cutting retries to 1 favours letting one real
  // attempt finish over blindly repeating an already-in-flight slow call.
  const isCloudRun = !!(r.baseURL && r.baseURL.includes('.run.app'));
  const client = new OpenAI({
    ...(r.baseURL ? { baseURL: r.baseURL } : {}),
    apiKey: r.apiKey || 'missing',
    timeout: 90_000,
    maxRetries: 1,
    ...(isCloudRun ? {
      fetch: async (url: any, init: any = {}) => {
        try {
          const origin = new URL(r.baseURL!).origin;
          const token = await getGcpIdentityToken(origin);
          if (token) {
            const headers = new Headers(init?.headers || {});
            headers.set('Authorization', `Bearer ${token}`);
            init.headers = headers;
          }
        } catch (e: any) {
          console.warn('[llm/provider] failed to inject GCP token:', e.message);
        }
        return fetch(url, init);
      },
    } : {}),
  });
  clients.set(cacheKey, client);
  return client;
}
