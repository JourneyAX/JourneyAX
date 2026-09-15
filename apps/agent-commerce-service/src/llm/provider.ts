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
import { execSync } from 'child_process';
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

  // 1. Running inside GCP Cloud Run (Metadata service) — the real production
  // path. Uses the Cloud Run service's own attached identity; nothing to
  // configure.
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

  // 2. Dedicated service account key (local dev / any non-GCP host). Preferred
  // over the gcloud CLI fallback below: a service account never needs
  // interactive reauth, so local dev doesn't silently 401 whenever a
  // developer's personal `gcloud auth login` session (Workspace reauth
  // policy) lapses.
  {
    const token = await getServiceAccountIdToken(targetAudience);
    if (token) {
      cachedGcpToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
      return token;
    }
  }

  // 3. Explicit environment variable override
  if (process.env.GCP_ID_TOKEN || process.env.PLACEMAKER_MODEL_TOKEN) {
    const token = (process.env.GCP_ID_TOKEN || process.env.PLACEMAKER_MODEL_TOKEN)!.trim();
    cachedGcpToken = { token, expiresAt: now + 50 * 60 * 1000, audience: targetAudience };
    return token;
  }

  // 4. Local development machine fallback (gcloud CLI, personal login — needs
  // periodic interactive reauth under a Workspace reauth policy; prefer #2
  // above where possible). MUST pass --audiences:
  // without it, `gcloud auth print-identity-token` mints a token whose `aud`
  // claim is gcloud's own default client, not this Cloud Run service — Cloud
  // Run's IAM front door then rejects it with exactly the symptom this was
  // built to fix, a 401 `Bearer error="invalid_token"`, before the request
  // ever reaches the model server.
  try {
    const token = execSync(
      `gcloud auth print-identity-token --audiences=${JSON.stringify(targetAudience)}`,
      // stderr dropped: an expired personal login otherwise prints gcloud's
      // re-auth instructions into the service log on every call.
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (token) {
      cachedGcpToken = { token, expiresAt: now + 45 * 60 * 1000, audience: targetAudience };
      return token;
    }
  } catch {
    // gcloud not in PATH or unauthenticated
  }

  return '';
}

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
    case 'jax':
    case 'jax-placemakers':
    case 'placemaker':
    case 'placemaker-gemma': {
      // JAX PlaceMakers custom model server (Cloud Run NVIDIA L4 GPU / local fallback)
      return {
        baseURL: baseUrlOverride || process.env.JAX_PLACEMAKERS_MODEL_URL || process.env.PLACEMAKER_MODEL_URL || 'http://localhost:8085/v1',
        apiKey: (projectKey && projectKey.trim()) || 'journeyax-l4-gpu',
        ok: true,
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
