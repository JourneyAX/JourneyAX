import { Controller, All, Req, Res, Inject } from '@nestjs/common';
import { Request, Response } from 'express';
import { GatewayService } from './gateway.service';

/**
 * JourneyAX API Gateway Controller
 * 
 * The SINGLE entry point between the UI and ALL backend microservices.
 * 
 * Request Flow:
 * ┌──────────────┐     ┌──────────────────┐     ┌──────────────────────────┐
 * │  UI (Next.js) │ ──→ │  API Gateway      │ ──→ │  Backend Services         │
 * │  port: 3008   │     │  port: 3010       │     │  ┌─ JourneyAXController   │
 * │               │     │  ┌─ Auth Guard    │     │  │  (agent-commerce:3004) │
 * │  ChatPanel ───┤     │  ├─ Tenant Resolve│     │  ├─ ProductService        │
 * │  BackOffice ──┤     │  ├─ Rate Limit    │     │  │  (product:8083)        │
 * │               │     │  └─ Route Proxy   │     │  ├─ ProjectService        │
 * └──────────────┘     └──────────────────┘     │  │  (project:8082)        │
 *                                                │  ├─ AuthService           │
 *                                                │  │  (auth:8080)           │
 *                                                │  └─ AnalyticsService      │
 *                                                │     (analytics:8086)      │
 *                                                └──────────────────────────┘
 */
@Controller()
export class GatewayController {
  constructor(@Inject(GatewayService) private readonly gatewayService: GatewayService) {}

  /**
   * Catch-all proxy handler.
   * Every request to /api/v1/* is routed to the correct backend service
   * after passing through auth validation and tenant resolution.
   */
  @All('*')
  async proxy(@Req() req: Request, @Res() res: Response) {
    const path = req.originalUrl;
    const method = req.method;
    const tenantId = (req.headers['x-tenant-id'] as string) || 'caroma';

    // Only proxy /api/v1/* routes; pass through health check
    if (path === '/health' || path === '/health/') {
      return res.json({
        status: 'ok',
        service: 'api-gateway',
        timestamp: new Date().toISOString(),
        downstream: await this.gatewayService.checkHealth(),
      });
    }

    if (!path.startsWith('/api/v1/')) {
      return res.status(404).json({ error: 'Not Found', message: `No route for ${path}` });
    }

    console.log(`[Gateway] ${method} ${path} | tenant=${tenantId}`);

    // SSE streaming routes are piped through untouched (no buffering).
    if (path.includes('/chat/stream')) {
      try {
        await this.gatewayService.proxyStream(method, path, req.headers, req.body, res);
      } catch (error: any) {
        console.error(`[Gateway] Stream error: ${error.message}`);
        if (!res.headersSent) res.status(502).json({ error: 'Bad Gateway', message: error.message });
        else res.end();
      }
      return;
    }

    try {
      const result = await this.gatewayService.proxyRequest(method, path, req.headers, req.body);

      // Forward status code and headers
      res.status(result.status);

      // Forward response headers from downstream
      if (result.headers) {
        for (const [key, value] of Object.entries(result.headers)) {
          if (value) res.setHeader(key, value as string);
        }
      }

      res.json(result.data);
    } catch (error: any) {
      console.error(`[Gateway] Proxy error: ${error.message}`);
      res.status(502).json({
        error: 'Bad Gateway',
        message: `Downstream service unavailable: ${error.message}`,
        path,
        timestamp: new Date().toISOString(),
      });
    }
  }

}
