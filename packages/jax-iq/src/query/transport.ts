import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { validIqResponse } from './response';
import type { IqContext, IqQuery, IqResponse } from './contracts';

export const IQ_ASSERTION_HEADER = 'x-jax-iq-assertion';
const Word = z.string().min(1).max(200);
const ContextSchema = z.object({
  tenantId: Word, environmentId: z.enum(['dev', 'test', 'staging', 'production']), queryId: Word, correlationId: Word,
  disabledConnectors: z.array(Word).max(50).optional(),
  release: z.object({ version: Word, checksum: Word }).strict(),
  principal: z.object({ id: Word, audience: z.enum(['staff', 'shopper']), groups: z.array(Word).max(50),
    subjects: z.array(z.object({ thing: Word, canonicalId: Word, role: Word.optional() }).strict()).max(100),
    identities: z.array(z.object({ thing: Word, keyKind: Word, value: Word, role: Word.optional() }).strict()).max(100).optional(),
  }).strict(),
}).strict();
const AssertionSchema = z.object({ purpose: z.literal('jax-iq-query-v1'), context: ContextSchema, bodyHash: z.string().regex(/^[a-f0-9]{64}$/), iat: z.number().int(), exp: z.number().int(), jti: z.string().uuid() }).strict();
const digest = (body: unknown) => createHash('sha256').update(JSON.stringify(body)).digest('hex');

/** A separate audience/key from gateway and connector credentials, bound to the exact request body and release. */
export function signIqRequest(context: IqContext, body: IqQuery, secret: string, now = Date.now()): string {
  if (secret.length < 32) throw new Error('IQ signing key is not configured securely.');
  const iat = Math.floor(now / 1000);
  const payload = AssertionSchema.parse({ purpose: 'jax-iq-query-v1', context, bodyHash: digest(body), iat, exp: iat + 60, jti: randomUUID() });
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${createHmac('sha256', secret).update(encoded).digest('hex')}`;
}

export function verifyIqRequest(token: string, body: unknown, secret: string, expected: { tenantId: string; environmentId: string }, now = Date.now()): { context: IqContext; jti: string; expiresAt: Date } {
  if (secret.length < 32 || token.length > 40_000) throw new Error('IQ authentication refused.');
  const parts = token.split('.');
  if (parts.length !== 2 || !/^[a-f0-9]{64}$/.test(parts[1])) throw new Error('IQ authentication refused.');
  const signature = createHmac('sha256', secret).update(parts[0]).digest();
  if (!timingSafeEqual(signature, Buffer.from(parts[1], 'hex'))) throw new Error('IQ authentication refused.');
  const parsed = AssertionSchema.parse(JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')));
  const seconds = Math.floor(now / 1000);
  if (parsed.iat > seconds + 5 || parsed.exp <= seconds || parsed.exp - parsed.iat > 60 || parsed.exp <= parsed.iat || parsed.bodyHash !== digest(body) || parsed.context.tenantId !== expected.tenantId || parsed.context.environmentId !== expected.environmentId) throw new Error('IQ scope or lifetime mismatch.');
  return { context: parsed.context, jti: parsed.jti, expiresAt: new Date(parsed.exp * 1000) };
}

export interface IqClient { query(request: IqQuery, context: IqContext, signal?: AbortSignal): Promise<IqResponse> }

/** All application surfaces call the hosted service; failure is explicit, never a direct-source fallback. */
export class HttpIqClient implements IqClient {
  constructor(private readonly options: { baseUrl: () => string | undefined; secret: () => string | undefined; fetchImpl?: typeof fetch; timeoutMs?: number; serviceHeaders?: (target: string) => Promise<Record<string, string>> }) {}
  async query(request: IqQuery, context: IqContext, signal?: AbortSignal): Promise<IqResponse> {
    const unavailable = (): IqResponse => ({ ok: false, code: 'release_unavailable', queryId: context.queryId });
    const raw = this.options.baseUrl(); const secret = this.options.secret();
    if (!raw || !secret) return unavailable();
    try {
      const url = new URL(raw);
      if (url.username || url.password || !['http:', 'https:'].includes(url.protocol) || (process.env.NODE_ENV === 'production' && url.protocol !== 'https:')) return unavailable();
      const timeout = AbortSignal.timeout(this.options.timeoutMs ?? 30_000);
      const response = await (this.options.fetchImpl ?? fetch)(`${raw.replace(/\/+$/, '')}/api/v1/${encodeURIComponent(context.tenantId)}/${encodeURIComponent(context.environmentId)}/iq/query`, {
        method: 'POST', headers: { ...(await this.options.serviceHeaders?.(url.origin)), 'content-type': 'application/json', [IQ_ASSERTION_HEADER]: signIqRequest(context, request, secret) },
        body: JSON.stringify(request), signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        redirect: 'error',
      });
      if (!response.ok || !response.body) return unavailable();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        for (;;) { const chunk = await reader.read(); if (chunk.done) break; size += chunk.value.length; if (size > 512_000) return unavailable(); chunks.push(chunk.value); }
      } finally { await reader.cancel().catch(() => {}); }
      const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!validIqResponse(value) || value.queryId !== context.queryId) return unavailable();
      if (value.ok && (value.release?.version !== context.release.version || value.release?.checksum !== context.release.checksum || !Array.isArray(value.records) || !Array.isArray(value.sources))) return unavailable();
      if (value.ok) {
        if ((request.operation === 'get' || request.operation === 'explain') && 'canonicalId' in request.subject) {
          const subject = request.subject;
          if (value.records.some(record => record.subject.thing !== subject.thing || record.subject.canonicalId !== subject.canonicalId)) return unavailable();
        }
        if (request.operation === 'find' && value.records.some(record => record.subject.thing !== request.thing)) return unavailable();
        if ('facts' in request && request.facts && value.records.some(record => record.facts.some(fact => !request.facts!.includes(fact.fact)))) return unavailable();
      }
      return value as IqResponse;
    } catch { return unavailable(); }
  }
}
