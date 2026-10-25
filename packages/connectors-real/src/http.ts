import { ToolError, type Deps, type Rec } from './types';

/** Cuts text to a length, with an ellipsis when something was cut. */
export const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** Removes every secret value from a piece of text before it can reach the model or a log. */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 6) out = out.split(secret).join('[hidden]');
  return out;
}

/** The first readable message in the error bodies the vendors send (a string, `message`, `error.message`, `error_description`, a list of them). */
export function vendorMessage(json: any, text: string): string {
  const candidates: unknown[] = [];
  if (Array.isArray(json)) candidates.push(json[0]?.message, json[0]?.error_description);
  if (json && typeof json === 'object' && !Array.isArray(json)) {
    candidates.push(
      json.error?.['pbi.error']?.details?.[0]?.detail?.value, // Power BI: the useful part of a failed query
      json.message, json.error_description, json.error?.message, json.errors?.[0]?.message, json.error?.details?.[0]?.message,
      typeof json.error === 'string' ? json.error : undefined,
    );
  }
  const found = candidates.find((value): value is string => typeof value === 'string' && value.trim() !== '');
  return clip((found ?? text ?? '').replace(/\s+/g, ' ').trim(), 240);
}

/** What a failed call means for the model, by the HTTP status. The vendor's own words are kept short and never include a secret. */
export function errorFor(system: string, status: number, detail: string): ToolError {
  const said = detail ? ` (${detail})` : '';
  if (status === 401) return new ToolError('not_authorised', `${system} did not accept our sign-in${said}. An administrator needs to check the connection.`);
  if (status === 403) return new ToolError('not_authorised', `${system} does not allow this connection to do that${said}. Its permissions may need widening.`);
  if (status === 404) return new ToolError('not_found', `${system} has no such record${said}.`);
  if (status === 409) return new ToolError('conflict', `${system} says the record changed while we were using it${said}. Try again.`);
  if (status === 429) return new ToolError('rate_limited', `${system} is limiting how fast we may ask${said}. Try again in a minute.`);
  if (status >= 500) return new ToolError('unavailable', `${system} is not answering properly right now${said}.`);
  return new ToolError('rejected', `${system} rejected the request${said}.`);
}

/** A sign-in token kept until just before it expires. Concurrent callers share one sign-in. */
export class TokenCache {
  private current?: { value: string; expiresAt: number };
  private pending?: Promise<string>;

  constructor(private readonly now: () => number) {}

  async get(fetchToken: () => Promise<{ token: string; expiresInSec: number }>): Promise<string> {
    if (this.current && this.current.expiresAt > this.now()) return this.current.value;
    if (!this.pending) {
      this.pending = fetchToken()
        .then(({ token, expiresInSec }) => {
          // Renew a minute early, but never keep a token for less than ten seconds.
          const lifetimeMs = Math.max(10_000, (expiresInSec - 60) * 1000);
          this.current = { value: token, expiresAt: this.now() + lifetimeMs };
          return token;
        })
        .finally(() => { this.pending = undefined; });
    }
    return this.pending;
  }

  clear(): void {
    this.current = undefined;
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  /** `form` sends the body as application/x-www-form-urlencoded (token calls); the default is JSON. */
  form?: Record<string, string>;
  headers?: Record<string, string>;
  timeoutMs?: number;
}

export interface Answer { status: number; ok: boolean; json: any; text: string }

/** One HTTP call, with a timeout, no redirects, and the body read as JSON when it is. Network failures become a plain "not reachable". */
export async function send(deps: Deps, system: string, method: string, url: string, options: RequestOptions = {}): Promise<Answer> {
  const target = new URL(url);
  for (const [key, value] of Object.entries(options.query ?? {})) if (value !== undefined) target.searchParams.set(key, String(value));
  const headers: Record<string, string> = { accept: 'application/json', ...(options.headers ?? {}) };
  let body: string | undefined;
  if (options.form) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  let response: Response;
  try {
    response = await deps.fetchImpl(target.toString(), { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(options.timeoutMs ?? 15_000) });
  } catch (error: any) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    throw new ToolError(timedOut ? 'timeout' : 'unavailable', timedOut ? `${system} took too long to answer.` : `${system} could not be reached (${target.host}).`);
  }
  const text = await response.text().catch(() => '');
  let json: any;
  try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
  return { status: response.status, ok: response.ok, json, text };
}

export interface VendorClientOptions {
  system: string;
  deps: Deps;
  /** Secret values to strip from anything said about a failure. */
  secrets: () => string[];
  /** A current bearer token. */
  token: () => Promise<string>;
  /** Forget the token (called once after a 401, then the call is tried again). */
  forgetToken: () => void;
  headers?: Record<string, string>;
  /** Lets a connector name a failure its own way when the vendor signals it in the body rather than the status (a limit reached, say). */
  onError?: (answer: Answer) => ToolError | undefined;
}

/** Calls a vendor's API with a bearer token, renews the token once on a 401, and turns failures into messages fit for the model. */
export class VendorClient {
  constructor(private readonly options: VendorClientOptions) {}

  async json(method: string, url: string, request: Omit<RequestOptions, 'form'> = {}): Promise<any> {
    const attempt = async () => send(this.options.deps, this.options.system, method, url, {
      ...request,
      headers: { ...(this.options.headers ?? {}), ...(request.headers ?? {}), authorization: `Bearer ${await this.options.token()}` },
    });
    let answer = await attempt();
    if (answer.status === 401) {
      this.options.forgetToken();
      answer = await attempt();
    }
    if (!answer.ok) throw this.options.onError?.(answer) ?? errorFor(this.options.system, answer.status, redact(vendorMessage(answer.json, answer.text), this.options.secrets()));
    return answer.json ?? {};
  }
}

/**
 * The Merchant Center hands an API client out as a block of CTP_* lines. Those names are accepted as they come, so the block can be pasted
 * into the settings file without renaming anything. The COMMERCETOOLS_* name always wins when both are set, which is how a second, narrower
 * client replaces the pasted one for the chat while the loader keeps the pasted (wide) one.
 */
const ALIASES: Record<string, string[]> = {
  COMMERCETOOLS_PROJECT_KEY: ['CTP_PROJECT_KEY'],
  COMMERCETOOLS_CLIENT_ID: ['CTP_CLIENT_ID'],
  COMMERCETOOLS_CLIENT_SECRET: ['CTP_CLIENT_SECRET'],
  COMMERCETOOLS_API_URL: ['CTP_API_URL'],
  COMMERCETOOLS_AUTH_URL: ['CTP_AUTH_URL'],
  COMMERCETOOLS_LOADER_CLIENT_ID: ['CTP_CLIENT_ID'],
  COMMERCETOOLS_LOADER_CLIENT_SECRET: ['CTP_CLIENT_SECRET'],
};
const REGION_IN_HOST = /^https?:\/\/(?:api|auth)\.([a-z0-9.-]+?)\.commercetools\.com(?:[/:]|$)/i;

/** A required setting, trimmed; undefined when missing or blank. */
export const setting = (env: Record<string, string | undefined>, name: string): string | undefined => {
  const value = [name, ...(ALIASES[name] ?? [])].map((candidate) => env[candidate]?.trim()).find(Boolean);
  if (value) return value;
  // The region is the middle of the host the API client came with (api.us-central1.gcp.commercetools.com).
  if (name === 'COMMERCETOOLS_REGION') {
    const host = setting(env, 'COMMERCETOOLS_API_URL') ?? setting(env, 'COMMERCETOOLS_AUTH_URL');
    return host ? REGION_IN_HOST.exec(host)?.[1] : undefined;
  }
  return undefined;
};

export const settingsMissing = (env: Record<string, string | undefined>, names: string[]): string[] => names.filter((name) => !setting(env, name));

/** A whole number between two bounds, defaulting when not given. */
export function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Plain objects only: drops undefined and empty values so results stay small. */
export function compact(record: Rec): Rec {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined && value !== null && value !== ''));
}
