import { Controller, Post, Get, Body, Headers, Param, Req, Res, Inject, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AgentService } from './agent.service';
import { ChatThrottleGuard } from './common/chat-throttle.guard';
import { QuoteService } from './commerce/quote.service';
import { OrderService } from './commerce/order.service';
import { RosterService } from './commerce/roster.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { ConfigLoader } from './pipeline/config-loader';
import { SessionStore } from './pipeline/session-store';

@Controller('api/v1/:projectId/commerce')
export class JourneyAXController {
  private readonly configLoader = new ConfigLoader();
  private readonly sessions = new SessionStore();
  constructor(
    @Inject(AgentService) private readonly agentService: AgentService,
    @Inject(QuoteService) private readonly quoteService: QuoteService,
    @Inject(OrderService) private readonly orderService: OrderService,
    @Inject(RosterService) private readonly rosterService: RosterService,
    @Inject(SchoolResearchService) private readonly schoolResearch: SchoolResearchService,
  ) {}

  /**
   * Research a school's brand live (AUG-48) — the journey's opening step.
   *
   * Returns official colours (mapped to this brand's palette), mascot, typeface,
   * logo source + usage rules, and cited sources, for the customer to CONFIRM
   * before any product renders. Uses the project's own LLM key; cached per
   * school so a repeat visit is instant.
   */
  @Post('research-school')
  async researchSchool(
    @Param('projectId') projectId: string,
    @Body() body: { school?: string; location?: string; force?: boolean },
  ) {
    const tenantId = (projectId || '').toLowerCase();
    const school = String(body?.school || '').trim();
    if (!school) return { error: 'school is required' };

    const cfg: any = await this.configLoader.loadProjectConfig(tenantId).catch(() => ({}));
    // The brand palette gives research colours something real to map onto.
    let palette: { name: string; hex?: string }[] = [];
    try {
      const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
      const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/renderer-config`);
      if (res.ok) {
        const rc: any = await res.json();
        palette = (rc?.paletteDetail || rc?.palette || []).map((c: any) =>
          typeof c === 'string' ? { name: c } : { name: c.name || c.display, hex: c.hex || c.render });
      }
    } catch { /* palette is an enhancement; research still works without it */ }

    return this.schoolResearch.research({
      tenantId, school, location: body?.location, force: body?.force,
      provider: cfg.provider, apiKey: cfg.apiKey, baseUrl: cfg.baseUrl,
      model: cfg.researchModel,
      palette,
    });
  }


  /**
   * Read a pasted roster and PROPOSE how to interpret it (AUG-32).
   *
   * Deliberately does not save anything. The response carries the column
   * mapping we inferred and why, so the customer confirms it before a single
   * garment is ordered — a misread column prints the wrong name on a shirt or
   * orders two dozen of the wrong size.
   */
  @Post('roster/parse')
  async parseRoster(
    @Param('projectId') projectId: string,
    @Body() body: { text?: string; garments?: string[] },
  ) {
    const garments = body?.garments?.length ? body.garments : ['jersey'];
    const parsed = this.rosterService.parse(body?.text || '', garments);

    // Sizes are checked against the project's own scale; with none configured we
    // report that we could not check rather than implying we did.
    const project: any = await this.configLoader
      .loadProjectConfig((projectId || '').toLowerCase())
      .catch(() => null);
    const scale: string[] | undefined = project?.sizeScale;
    const rows = this.rosterService.validate(parsed.rows, scale, garments);

    return {
      ...parsed,
      rows,
      needsReview: rows.filter((r) => r.issues.length),
      sizeScaleConfigured: !!scale?.length,
    };
  }

  /**
   * Turn a confirmed roster into quote lines and price it.
   *
   * The roster contributes SKUs and quantities ONLY; the quote engine computes
   * every monetary figure (P0-04). `skuByGarment` comes from the kit the
   * customer configured, so a youth or ladies cut orders its own SKU.
   */
  @Post('roster/quote')
  async quoteRoster(
    @Param('projectId') projectId: string,
    @Body() body: { rows?: any[]; skuByGarment?: Record<string, string>; sessionId?: string; title?: string },
  ) {
    const rows = body?.rows || [];
    const skuByGarment = body?.skuByGarment || {};
    if (!rows.length) return { error: 'No roster rows supplied.' };
    if (!Object.keys(skuByGarment).length) {
      return { error: 'No garment chosen yet — configure the kit before pricing a roster.' };
    }

    const tenantId = (projectId || '').toLowerCase();
    const items = this.rosterService.toQuoteLines(rows, skuByGarment);
    // Pricing comes from PROJECT CONFIG and the quote engine does the arithmetic
    // — the roster only ever says which SKU and how many.
    const project: any = await this.configLoader.loadProjectConfig(tenantId).catch(() => null);
    const quote = await this.quoteService.build({
      tenantId,
      sessionId: body?.sessionId,
      title: body?.title || 'Team order',
      items,
      pricing: project?.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
    });
    return { quote, players: rows.length, lines: items.length };
  }

  /**
   * Price the kit the customer has hung on the rack.
   *
   * The rack is browser state, so asking the model to "quote what's in my rack"
   * gives it nothing to work from — it answers in prose and no quote appears.
   * This route takes the rack contents directly and prices them, so the same
   * click always produces the same quote.
   *
   * The browser sends styles and counts only; every figure comes from the
   * catalogue price and this project's configured tax and discount (P0-04).
   */
  @Post('kit/quote')
  async quoteKit(
    @Param('projectId') projectId: string,
    @Body() body: { items?: Array<{ sku: string; quantity?: number }>; sessionId?: string; title?: string },
  ) {
    const tenantId = (projectId || '').toLowerCase();

    /* How many of each — from the roster the customer already gave.
     * The browser doesn't know the team size (it lives in the session), so a
     * 14-player order priced from the rack would otherwise come back as one of
     * each and understate the order by an order of magnitude. */
    let teamSize = 0;
    if (body?.sessionId) {
      const stored = await this.sessions.load(body.sessionId, tenantId).catch(() => null);
      teamSize = Number(stored?.journeyState?.teamSize) || 0;
    }

    const items = (body?.items || [])
      .filter((i) => i && typeof i.sku === 'string' && i.sku.trim())
      .map((i) => ({
        sku: i.sku.trim(),
        quantity: Number(i.quantity) > 0 ? Number(i.quantity) : teamSize || 1,
      }));
    if (!items.length) return { error: 'Nothing on the rack to price yet.' };

    const project: any = await this.configLoader.loadProjectConfig(tenantId).catch(() => null);
    const quote = await this.quoteService.build({
      tenantId,
      sessionId: body?.sessionId,
      title: body?.title || 'Team kit',
      items,
      pricing: project?.pricing || { currency: 'AUD', symbol: '$', taxRate: 0, discountRate: 0 },
    });
    return { quote, lines: items.length };
  }

  /**
   * Live AI Chat endpoint.
   * Receives chat requests via API Gateway (Kong),
   * runs the ReAct Thought-Action-Observation loop via AgentService,
   * and returns the final message + UI actions.
   * 
   * Flow: Client → API Gateway → JourneyAXController → AgentService → ProductService → MongoDB
   */
  @Post('chat')
  @UseGuards(ChatThrottleGuard)
  async chat(
    @Param('projectId') projectId: string,
    @Headers('x-tenant-id') tenantHeader: string,
    @Body() body: {
      message?: string;
      messages?: any[];
      customerId?: string;
      state?: {
        phase?: string;
        bom?: any[];
        recommendedProducts?: any[];
        finish?: string;
        qty?: number;
      };
      tenantId?: string;
      sessionId?: string;
    }
  ) {
    // Tenant identity comes from the URL projectId (validated by the gateway
    // against the JWT). The gateway's trusted x-tenant-id header equals it; body
    // tenantId is only a last-resort dev fallback with no gateway in front.
    const tenantId = (projectId || tenantHeader || body.tenantId || 'caroma').toLowerCase();

    console.log(`[JourneyAX] Chat request: tenant=${tenantId}, messages=${body.messages?.length || 0}`);

    try {
      const result = await this.agentService.processChat({
        message: body.message,
        messages: body.messages,
        customerId: body.customerId,
        state: body.state,
        tenantId,
        sessionId: body.sessionId,
      });

      return result;
    } catch (error: any) {
      console.error('[JourneyAX] Chat error:', error);
      return {
        message: { role: 'assistant', content: `🚨 **Error:** ${error.message || 'An error occurred during AI processing.'}` },
        conversation: [],
        uiActions: [],
      };
    }
  }

  /**
   * Streaming AI Chat endpoint (Server-Sent Events).
   * Same pipeline as /chat, but streams `trace`, `uiAction`, `token`, `done`
   * events. The storefront falls back to the buffered /chat on any failure.
   */
  @Post('chat/stream')
  @UseGuards(ChatThrottleGuard)
  async chatStream(
    @Param('projectId') projectId: string,
    @Headers('x-tenant-id') tenantHeader: string,
    @Body() body: { message?: string; messages?: any[]; customerId?: string; state?: any; tenantId?: string; sessionId?: string },
    @Res() res: Response,
  ) {
    const tenantId = (projectId || tenantHeader || body.tenantId || 'caroma').toLowerCase();
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
    (res as any).flushHeaders?.();

    const emit = (event: string, data: any) => {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        (res as any).flush?.();
      } catch {
        /* client disconnected */
      }
    };

    // Keepalive: the quote turn has a long silent gap (multiple searches + BOM
    // assembly) with no events. Without a heartbeat, proxies/browsers can drop
    // the idle SSE connection before the tokens arrive. SSE comment lines (": ")
    // are ignored by clients but keep the connection warm.
    const heartbeat = setInterval(() => {
      try {
        res.write(`: ping\n\n`);
        (res as any).flush?.();
      } catch {
        /* client disconnected */
      }
    }, 4000);

    try {
      await this.agentService.processChatStream(
        { message: body.message, messages: body.messages, customerId: body.customerId, state: body.state, tenantId, sessionId: body.sessionId },
        emit,
      );
    } catch (error: any) {
      console.error('[JourneyAX] Stream error:', error);
      emit('error', { message: error.message || 'stream error' });
    } finally {
      clearInterval(heartbeat);
      res.end();
    }
  }

  /**
   * Get a persisted quote by id (tenant-scoped). The storefront reads the
   * authoritative quote here rather than trusting any client-held totals.
   */
  @Get('quote/:quoteId')
  async getQuote(@Param('projectId') projectId: string, @Param('quoteId') quoteId: string) {
    const tenantId = (projectId || 'caroma').toLowerCase();
    const quote = await this.quoteService.get(quoteId, tenantId);
    if (!quote) return { found: false };
    return { found: true, quote };
  }

  /**
   * Commit an order from a quote (P0-04). Idempotent on `idempotencyKey`.
   * Re-validates the quote server-side, then opens a REAL Stripe Checkout Session.
   * The storefront redirects the customer to `checkoutUrl`; the order is not
   * "paid" until Stripe's signed webhook confirms it.
   */
  @Post('order')
  @UseGuards(ChatThrottleGuard)
  async createOrder(
    @Param('projectId') projectId: string,
    @Body() body: { quoteId: string; idempotencyKey?: string; customer?: { email?: string; name?: string }; successUrl?: string; cancelUrl?: string },
  ) {
    const tenantId = (projectId || 'caroma').toLowerCase();
    const quote = await this.quoteService.get(body.quoteId, tenantId);
    if (!quote) return { success: false, error: 'Quote not found or expired.' };

    const cfg = await this.configLoader.loadProjectConfig(tenantId);
    const base = process.env.STOREFRONT_URL || 'http://localhost:3008';
    const result = await this.orderService.create({
      tenantId,
      quote,
      idempotencyKey: body.idempotencyKey || `${quote.quoteId}`,
      customer: body.customer,
      successUrl: body.successUrl || `${base}/?project=${tenantId}&order={ORDER_ID}&status=success`,
      cancelUrl: body.cancelUrl || `${base}/?project=${tenantId}&status=cancelled`,
      stripe: { secretKey: cfg.stripe?.secretKey },
    });
    if (result.status === 'failed') return { success: false, ...result };
    if (result.status === 'paid') await this.quoteService.markStatus(quote.quoteId, 'ordered');
    return { success: true, ...result };
  }

  /** Order status — the storefront polls this after returning from Stripe. */
  @Get('order/:orderId')
  async getOrder(@Param('projectId') projectId: string, @Param('orderId') orderId: string) {
    const tenantId = (projectId || 'caroma').toLowerCase();
    const order = await this.orderService.get(orderId, tenantId);
    if (!order) return { found: false };
    /* A confirmation has to show WHAT was bought, not just a number.
     *
     * This returned a total and nothing else, so the panel had no items to list
     * and fell back to the browser's own (empty) state — a customer who had
     * just paid $161 was shown "Price on request". The lines are already on the
     * order; they were simply never sent. Money still comes from the server. */
    const o: any = order;
    /* The order records WHAT WAS PAID (total, status, Stripe session) and points
     * at the quote for the detail — the lines live there, priced by the quote
     * engine. Read them back so the confirmation can show the customer the
     * items they just bought rather than a bare number. */
    const quote: any = o.quoteId ? await this.quoteService.get(o.quoteId, tenantId).catch(() => null) : null;
    const lines = (o.lines || quote?.lines || []).map((l: any) => ({
      sku: l.sku, name: l.name, quantity: l.quantity,
      unitPrice: l.unitPrice, lineTotal: l.lineTotal, imageUrl: l.imageUrl,
    }));
    return {
      found: true,
      orderId: order.orderId,
      status: order.status,
      total: order.total,
      currency: order.currency,
      symbol: o.symbol ?? quote?.symbol,
      title: o.title ?? quote?.title,
      paidAt: o.paidAt ?? null,
      leadTimeSummary: o.leadTimeSummary ?? quote?.leadTimeSummary,
      lines,
    };
  }

  /**
   * Stripe webhook — flips orders to paid/failed on Stripe's signed events.
   * Uses the RAW body (signature is computed over exact bytes). Mounted with a
   * raw body parser in main.ts for this path only.
   */
  @Post('stripe/webhook')
  async stripeWebhook(
    @Param('projectId') projectId: string,
    @Req() req: Request,
    @Headers('stripe-signature') signature: string,
  ) {
    const tenantId = (projectId || 'caroma').toLowerCase();
    const cfg = await this.configLoader.loadProjectConfig(tenantId);
    const raw = (req as any).rawBody instanceof Buffer ? (req as any).rawBody.toString('utf8') : JSON.stringify(req.body || {});
    const out = await this.orderService.handleWebhook(raw, signature || '', cfg.stripe?.secretKey);
    if (out.handled?.startsWith('paid:')) {
      const order = await this.orderService.get(out.handled.slice('paid:'.length), tenantId);
      if (order) await this.quoteService.markStatus(order.quoteId, 'ordered');
    }
    return out.ok ? { received: true } : { received: false };
  }

  /**
   * Health check endpoint.
   */
  @Get('health')
  health() {
    return { status: 'ok', service: 'journeyax-commerce-service', timestamp: new Date().toISOString() };
  }
}
