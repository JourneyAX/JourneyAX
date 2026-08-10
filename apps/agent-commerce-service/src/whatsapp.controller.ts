import { Controller, Get, Post, Req, Res, Headers, HttpException, HttpStatus } from '@nestjs/common';
import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'crypto';
import { AgentService } from './agent.service';
import { WhatsAppService } from './commerce/whatsapp.service';

const GRAPH = process.env.WHATSAPP_GRAPH_VERSION || 'v21.0';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.WHATSAPP_APP_SECRET || '';
const CONFIGURED = Boolean(VERIFY_TOKEN && APP_SECRET);
const PROJECT_API = process.env.PROJECT_SERVICE_URL || 'http://localhost:8082';

interface TenantWa { tenantId: string; accessToken?: string }

@Controller('api/v1/:projectId/commerce/whatsapp/webhook')
export class WhatsappController {
  constructor(
    private readonly agentService: AgentService,
    private readonly whatsappService: WhatsAppService,
  ) {
    if (!CONFIGURED) {
      console.error(
        '[wa webhook] DISABLED — set WHATSAPP_VERIFY_TOKEN and WHATSAPP_APP_SECRET. ' +
        'The webhook will reject all traffic until both are configured (no default token, no unsigned POSTs).',
      );
    }
  }

  private verifySignature(rawBody: string, header: string | null): boolean {
    if (!header || !header.startsWith('sha256=')) return false;
    const expected = createHmac('sha256', APP_SECRET).update(rawBody, 'utf8').digest('hex');
    const provided = header.slice('sha256='.length);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(provided, 'hex');
    if (a.length !== b.length) return false;
    try { return timingSafeEqual(a, b); } catch { return false; }
  }

  private async resolveTenant(phoneNumberId: string): Promise<TenantWa | null> {
    try {
      const res = await fetch(`${PROJECT_API}/api/v1/projects/resolve/whatsapp/${encodeURIComponent(phoneNumberId)}`, { headers: { 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' } });
      if (!res.ok) return null;
      const r = await res.json();
      return { tenantId: r.tenantId, accessToken: r.accessToken };
    } catch {
      return null;
    }
  }

  @Get()
  async verify(@Req() req: Request, @Res() res: Response) {
    if (!CONFIGURED) return res.status(503).send('Webhook not configured');
    
    // Note: Gateway may not forward query parameters correctly depending on implementation,
    // so we get them from req.query
    const mode = req.query['hub.mode'] as string;
    const token = req.query['hub.verify_token'] as string;
    const challenge = req.query['hub.challenge'] as string;

    if (mode === 'subscribe' && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge || '');
    }
    return res.status(403).send('Forbidden');
  }

  @Post()
  async handleWebhook(@Req() req: Request, @Headers('x-hub-signature-256') signature: string, @Res() res: Response) {
    if (!CONFIGURED) return res.status(503).send('Webhook not configured');

    const raw = (req as any).rawBody instanceof Buffer ? (req as any).rawBody.toString('utf8') : JSON.stringify(req.body || {});
    if (!this.verifySignature(raw, signature)) {
      console.warn('[wa webhook] rejected: invalid or missing X-Hub-Signature-256');
      return res.status(401).send('invalid signature');
    }

    let payload: any;
    try {
      payload = JSON.parse(raw);
    } catch {
      return res.status(400).send('bad json');
    }

    try {
      const value = payload?.entry?.[0]?.changes?.[0]?.value;
      const phoneNumberId: string | undefined = value?.metadata?.phone_number_id;
      const messages = value?.messages;
      if (Array.isArray(messages) && phoneNumberId) {
        const tenant = await this.resolveTenant(phoneNumberId);
        if (!tenant) {
          console.warn(`[wa webhook] no project registered for phone_number_id=${phoneNumberId}`);
          return res.status(200).send('ok');
        }
        for (const msg of messages) {
          if (!msg?.id || (await this.whatsappService.alreadyProcessed(msg.id))) continue;
          const from: string = msg.from;
          const text: string | undefined =
            msg.type === 'text' ? msg.text?.body
            : msg.type === 'interactive'
              ? (msg.interactive?.list_reply?.title || msg.interactive?.button_reply?.title)
              : undefined;
          if (!from || !text) continue;
          await this.handleInbound(tenant, phoneNumberId, from, text);
        }
      }
    } catch (e) {
      console.error('[wa webhook] error', e);
    }
    return res.status(200).send('ok');
  }

  private async handleInbound(tenant: TenantWa, phoneNumberId: string, from: string, text: string) {
    const sessionId = await this.whatsappService.resolveSessionId(tenant.tenantId, from);
    let content = '';
    let uiActions: any[] = [];
    try {
      // Directly call AgentService instead of HTTP fetch
      const result = await this.agentService.processChat({
        tenantId: tenant.tenantId,
        sessionId,
        message: text,
      });
      content = result?.message?.content || '';
      uiActions = Array.isArray(result?.uiActions) ? result.uiActions : [];
    } catch (e) {
      console.error('[wa webhook] agent error:', e);
      content = `Sorry — I couldn't reach the assistant just now. Please try again in a moment.`;
    }

    if (content.trim()) await this.sendText(tenant, phoneNumberId, from, this.toWhatsAppText(content));

    const clarify = this.extractClarify(uiActions);
    if (clarify && clarify.options.length) {
      await this.sendList(tenant, phoneNumberId, from, 'Choose one', clarify.title, clarify.options.slice(0, 10));
    }
  }

  private toWhatsAppText(md: string): string {
    return md
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\*\*([^*]+)\*\*/g, '*$1*')
      .replace(/^#{1,6}\s*/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, 4096);
  }

  private extractClarify(uiActions: any[]): { title: string; options: string[] } | null {
    try {
      for (const a of uiActions) {
        let args: any = a?.arguments ?? a;
        if (typeof args === 'string') { try { args = JSON.parse(args); } catch { continue; } }
        const q = args?.questions?.[0];
        if (q?.title && Array.isArray(q?.options) && q.options.length) {
          return { title: String(q.title).slice(0, 60), options: q.options.map((o: any) => String(o)) };
        }
      }
    } catch { /* tolerate any shape */ }
    return null;
  }

  private async waSend(tenant: TenantWa, phoneNumberId: string, body: any) {
    if (!tenant.accessToken) {
      console.warn(`[wa webhook] tenant ${tenant.tenantId} has no WhatsApp access token configured (set it in the Channels tab).`);
      return;
    }
    const res = await fetch(`https://graph.facebook.com/${GRAPH}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tenant.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', ...body }),
    });
    if (!res.ok) console.error('[wa webhook] send failed', res.status, await res.text());
  }

  private sendText(tenant: TenantWa, phoneNumberId: string, to: string, body: string) {
    return this.waSend(tenant, phoneNumberId, { to, type: 'text', text: { preview_url: false, body } });
  }

  private sendList(tenant: TenantWa, phoneNumberId: string, to: string, buttonLabel: string, header: string, options: string[]) {
    return this.waSend(tenant, phoneNumberId, {
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: header.slice(0, 60) },
        body: { text: 'Tap to choose:' },
        action: {
          button: buttonLabel.slice(0, 20),
          sections: [{ rows: options.map((o, i) => ({ id: `opt_${i}`, title: o.slice(0, 24) })) }],
        },
      },
    });
  }
}
