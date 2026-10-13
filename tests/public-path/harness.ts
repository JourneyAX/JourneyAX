import 'reflect-metadata';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ReleaseActivationRepository } from '@journeyax/database';
import { computePackChecksum } from '@journeyax/business-pack';
import { buildPlaceMakersStack, TENANT, type PlaceMakersStack } from '../../apps/journey-runtime-service/test/helpers/placemakers-stack';

/**
 * The public path of a shop, hop for hop, on loopback with an isolated store:
 *
 *   browser → storefront route (Next route handler) → API gateway → commerce service → runtime → turn service
 *
 * Every hop is the real production code (the route handler, the gateway's auth and stream proxy, the commerce controller and its
 * stream coordinator and runtime adapter, the runtime's auth guard, activation gate and controller, the turn service on a pack
 * produced by the real publisher). What is not real: the language model (a fixed function), the database (an in-memory store),
 * and the two platform lookups the gateway makes (a stub that approves one test customer and one tenant).
 */

export const CUSTOMER_TOKEN = 'canary-customer-token';
export const INTERNAL_KEY = 'public-path-internal-key';
export const ASSERTION_SECRET = 'public-path-assertion-secret-0123456789';

export interface PublicPath {
  /** The URL a browser posts to. */
  chatStreamUrl: string;
  /** Each hop's own address, for tests that probe one hop directly. */
  urls: { storefront: string; gateway: string; commerce: string; runtime: string };
  /** Credentials of the stubbed signed-in customer. */
  customerHeaders: Record<string, string>;
  stack: PlaceMakersStack;
  activation: ReleaseActivationRepository;
  /** A deployed runtime re-reads the published pack when its cache expires; a test drops the cache to see a change at once. */
  invalidatePackCache: () => void;
  /** The release a conversation is bound to (its pins), read from the runtime's workspace store. */
  pinsOf: (workspaceId: string) => Promise<{ packChecksum?: string; packVersionId?: string } | undefined>;
  /** Records the SSE the runtime and the commerce service sent, before the public view, for what-reached-the-browser comparisons. */
  internalStream: Array<{ hop: string; event: string }>;
  stop: () => Promise<void>;
}

const listen = (server: http.Server) => new Promise<number>((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));

async function nest(module: any): Promise<{ port: number; close: () => Promise<void> }> {
  const app = await NestFactory.create(module, { logger: false });
  await app.listen(0, '127.0.0.1');
  const port = new URL(await app.getUrl()).port;
  return { port: Number(port), close: () => app.close() };
}

export async function startPublicPath(options: { stack?: PlaceMakersStack; storefrontAllowAnonymous?: boolean } = {}): Promise<PublicPath> {
  // The environment a customer's request lands in when it names none. This store is in memory: nothing here is a real environment.
  const ENVIRONMENT = 'production' as const;
  const stack = options.stack ?? await buildPlaceMakersStack({ environmentId: ENVIRONMENT });
  const closers: Array<() => Promise<void>> = [];

  // ── Platform stub: token verification and tenant validation, the two lookups the gateway makes ──
  const platform = http.createServer((request, response) => {
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(body)); };
    if (request.method === 'POST' && request.url === '/api/v1/auth/verify') {
      let raw = '';
      request.on('data', (chunk) => { raw += chunk; });
      request.on('end', () => {
        const token = JSON.parse(raw || '{}').token;
        if (token === CUSTOMER_TOKEN) return send(200, { valid: true, payload: { sub: 'canary-customer@example.test', tenantId: TENANT, role: 'buyer', fullName: 'Canary Customer' } });
        return send(401, { message: 'Invalid token.' });
      });
      return;
    }
    if (request.method === 'GET' && request.url?.startsWith(`/api/v1/projects/${TENANT}/published`)) return send(200, {});
    return send(404, { message: 'not found' });
  });
  const platformPort = await listen(platform);
  closers.push(() => new Promise((resolve) => platform.close(() => resolve())));

  // ── Environment every hop reads (set before the modules that read it at import) ──
  Object.assign(process.env, {
    NODE_ENV: 'test', DISABLE_GCP_AUTH: 'true', INTERNAL_API_KEY: INTERNAL_KEY, GATEWAY_ASSERTION_SECRET: ASSERTION_SECRET,
    AUTH_SERVICE_URL: `http://127.0.0.1:${platformPort}`, PROJECT_SERVICE_URL: `http://127.0.0.1:${platformPort}`,
    STOREFRONT_ALLOW_ANONYMOUS: options.storefrontAllowAnonymous ? 'true' : 'false',
    // Read when the commerce controller loads: generous per address, tight per conversation, so a rate-limit probe is quick.
    CHAT_RATE_PER_MIN_IP: '5000', CHAT_RATE_PER_MIN_SESSION: '6', CHAT_MAX_MESSAGE_CHARS: '4000',
  });
  delete process.env.MONGODB_URI;

  // ── Release activation: the real durable repository over the isolated store, approving the pack by version and checksum ──
  const activation = new ReleaseActivationRepository(async () => ({ db: stack.db as any, client: (stack.db as any).client }));
  await activation.promoteReleaseActivation(TENANT, ENVIRONMENT, {
    status: 'migrated', approvedReleaseVersion: stack.pack.manifest.version, approvedReleaseChecksum: computePackChecksum(stack.pack),
    expectedRevision: 0, approvedBy: 'human:release-manager', notes: 'public-path harness',
  });

  // ── Runtime ──
  const { RuntimeController } = await import('../../apps/journey-runtime-service/src/runtime.controller');
  const { RuntimeService } = await import('../../apps/journey-runtime-service/src/runtime.service');
  const runtimeService = new RuntimeService(stack.serviceFor({ servePacks: true }));
  runtimeService.setReleaseActivationRepositoryForTest(activation);
  @Module({ controllers: [RuntimeController], providers: [{ provide: RuntimeService, useValue: runtimeService }] })
  class RuntimeHarnessModule {}
  const runtime = await nest(RuntimeHarnessModule);
  closers.push(runtime.close);

  // ── Commerce service: the real controller, stream coordinator and runtime adapter; the activation router reads the real record ──
  process.env.JOURNEY_RUNTIME_SERVICE_URL = `http://127.0.0.1:${runtime.port}`;
  const { JourneyAXController } = await import('../../apps/agent-commerce-service/src/agent.controller');
  const { AgentService } = await import('../../apps/agent-commerce-service/src/agent.service');
  const { JourneyCoordinator } = await import('../../apps/agent-commerce-service/src/orchestration/journey-coordinator');
  const { TenantRuntimeActivationRouter } = await import('../../apps/agent-commerce-service/src/runtime/tenant-runtime-activation.router');
  const { CanonicalRuntimeAdapter } = await import('../../apps/agent-commerce-service/src/runtime/canonical-runtime.adapter');
  const { LegacyJourneyAdapter } = await import('../../apps/agent-commerce-service/src/legacy/legacy-journey-adapter');
  const { ConfigLoader } = await import('../../apps/agent-commerce-service/src/pipeline/config-loader');
  const { QuoteService } = await import('../../apps/agent-commerce-service/src/commerce/quote.service');
  const { OrderService } = await import('../../apps/agent-commerce-service/src/commerce/order.service');
  const { RosterService } = await import('../../apps/agent-commerce-service/src/commerce/roster.service');
  const { SchoolResearchService } = await import('../../apps/agent-commerce-service/src/commerce/school-research.service');
  const { WhatsAppService } = await import('../../apps/agent-commerce-service/src/commerce/whatsapp.service');
  const inert = {};
  @Module({
    controllers: [JourneyAXController],
    providers: [
      AgentService, JourneyCoordinator, CanonicalRuntimeAdapter, LegacyJourneyAdapter, ConfigLoader,
      { provide: 'RELEASE_ACTIVATION_REPOSITORY', useValue: activation },
      TenantRuntimeActivationRouter,
      // Not used by the chat stream; the controller only needs them to exist.
      { provide: QuoteService, useValue: inert }, { provide: OrderService, useValue: inert }, { provide: RosterService, useValue: inert },
      { provide: SchoolResearchService, useValue: inert }, { provide: WhatsAppService, useValue: inert },
    ],
  })
  class CommerceHarnessModule {}
  const commerce = await nest(CommerceHarnessModule);
  closers.push(commerce.close);

  // ── Gateway: the real module (tenant middleware, auth guard, stream proxy), pointed at the commerce service ──
  process.env.AGENT_SERVICE_URL = `http://127.0.0.1:${commerce.port}`;
  const { GatewayModule } = await import('../../apps/api-gateway/src/gateway.module');
  const gateway = await nest(GatewayModule);
  closers.push(gateway.close);

  // ── Storefront: the real Next route handler, served over HTTP ──
  process.env.GATEWAY_URL = `http://127.0.0.1:${gateway.port}`;
  const route = await import('../../apps/journeyax-web/src/app/api/chat/stream/route');
  const storefront = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const webRequest = new Request(`http://127.0.0.1${request.url}`, { method: request.method, headers: request.headers as any, body: chunks.length ? Buffer.concat(chunks) : undefined });
    const webResponse = await route.POST(webRequest);
    const headers: Record<string, string> = {};
    webResponse.headers.forEach((value, key) => { headers[key] = value; });
    response.writeHead(webResponse.status, headers);
    if (!webResponse.body) return response.end();
    const reader = webResponse.body.getReader();
    while (true) { const { done, value } = await reader.read(); if (done) break; response.write(Buffer.from(value)); }
    response.end();
  });
  const storefrontPort = await listen(storefront);
  closers.push(() => new Promise((resolve) => storefront.close(() => resolve())));

  return {
    chatStreamUrl: `http://127.0.0.1:${storefrontPort}/api/chat/stream?project=${TENANT}`,
    urls: { storefront: `http://127.0.0.1:${storefrontPort}`, gateway: `http://127.0.0.1:${gateway.port}`, commerce: `http://127.0.0.1:${commerce.port}`, runtime: `http://127.0.0.1:${runtime.port}` },
    customerHeaders: { Cookie: `jxs_at=${CUSTOMER_TOKEN}` },
    stack, activation, internalStream: [], invalidatePackCache: () => (runtimeService.appService as any).packRepo.invalidate(),
    pinsOf: async (workspaceId: string) => {
      const workspace = await (runtimeService.appService as any).workspaceRepo.load(TENANT, ENVIRONMENT, workspaceId);
      return workspace ? { packChecksum: workspace.pins?.packChecksum, packVersionId: workspace.packVersionId } : undefined;
    },
    stop: async () => { for (const close of closers.reverse()) await close().catch(() => undefined); },
  };
}
