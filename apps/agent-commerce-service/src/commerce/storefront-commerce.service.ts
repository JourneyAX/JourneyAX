import { Injectable, Optional, Inject } from '@nestjs/common';
import { QuoteService } from './quote.service';
import { OrderService } from './order.service';
import { pickNamedProduct } from '../pipeline/context-assembler';

export async function fetchPricebookRows(tenantId: string, skus: string[]): Promise<any[]> {
  if (!skus.length) return [];
  try {
    const base = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083';
    const res = await fetch(`${base}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-ID': tenantId,
        'X-Internal-Key': process.env.INTERNAL_API_KEY || '',
      },
      body: JSON.stringify({ skus }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return [];
    return ((await res.json())?.items || []) as any[];
  } catch {
    return [];
  }
}

@Injectable()
export class StorefrontCommerceService {
  constructor(
    @Optional() @Inject(QuoteService) private readonly quoteService: QuoteService = new QuoteService(),
    @Optional() @Inject(OrderService) private readonly orderService: OrderService = new OrderService()
  ) {}

  /**
   * Applies structured or natural-language cart/bag commands deterministically.
   */
  async applyStorefrontCartCommand(
    tenantId: string,
    sessionId: string,
    text: string,
    journeyState: any,
    projectConfig: any,
    uiToolCalls: any[],
    conversation: any[],
    emit?: (event: string, data: any) => void
  ): Promise<boolean> {
    const t = (text || '').trim();
    const add =
      t.match(/^Add SKU (\S+) \(qty (\d+)\) to my (?:bag|quote|cart)\.?$/i) ||
      (() => {
        const m = t.match(/^Add .+? \(SKU (\S+?), qty (\d+)\) to my (?:bag|quote|cart)\.?$/i);
        return m ? [m[0], m[1], m[2]] : null;
      })();

    const addMany =
      t.match(/^Add SKUs ((?:\S+ \(qty \d+\)(?:, )?)+) to my (?:bag|quote|cart)\.?$/i) ||
      (() => {
        const m = t.match(/^Add these to my (?:bag|quote|cart): (.+)$/i);
        return m ? [m[0], m[1].replace(/\(SKU (\S+?), qty (\d+)\)/g, '$1 (qty $2)')] : null;
      })();

    const remove = t.match(/^Remove SKU (\S+) from my (?:bag|quote|cart)\.?$/i);
    const change = t.match(/^Change the quantity of SKU (\S+) to (\d+)\.?$/i);

    if (!add && !addMany && !remove && !change) {
      const num: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
      const typedAdd = t.match(
        /^(?:please\s+)?(?:add|put)\s+(?:(\d+|one|two|three|four|five)\s+(?:of\s+)?)?(?:the\s+|these\s+|those\s+|it\s+|them\s+|that\s+|this\s+)?(.*?)\s*(?:(?:to|in|into)\s+(?:my\s+|the\s+)?(?:bag|cart|basket))?\s*[.!]?$/i
      );
      const typedRemove =
        !typedAdd &&
        t.match(
          /^(?:please\s+)?(?:remove|delete|take\s+out)\s+(?:the\s+)?(.*?)\s*(?:(?:from|out\s+of)\s+(?:my\s+|the\s+)?(?:bag|cart|basket))?\s*[.!]?$/i
        );
      const typedQty =
        !typedAdd &&
        !typedRemove &&
        t.match(
          /^(?:please\s+)?(?:change|make|set|update)\s+(?:the\s+)?(?:quantity\s+of\s+)?(.*?)\s*(?:quantity\s+)?(?:to|=)\s+(\d+|one|two|three|four|five)\s*[.!]?$/i
        );

      if (!typedAdd && !typedRemove && !typedQty) return false;
      const bagWordT = projectConfig?.commerceMode === 'cart' ? 'bag' : 'quote';
      const bag = journeyState?.quoteId
        ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null)
        : null;
      const bagLines = (bag?.lines || []).map((l: any) => ({ sku: String(l.sku), name: l.name }));
      const shownAll = [
        ...(journeyState?.lastShown || []),
        ...((journeyState?.selections?.products || []).map((p: any) => ({
          sku: String(p.sku || ''),
          name: p.name,
        }))),
      ];
      const pool = typedAdd ? [...bagLines, ...shownAll] : bagLines;
      const ref = typedAdd ? typedAdd[2] : typedRemove ? typedRemove[1] : (typedQty as RegExpMatchArray)[1];
      const pick = pickNamedProduct(ref || '', pool);
      if (!pick) return false;

      const sentence = typedAdd
        ? `Add ${pick.name || pick.sku} (SKU ${pick.sku}, qty ${
            typedAdd[1] ? num[typedAdd[1].toLowerCase()] || Number(typedAdd[1]) || 1 : 1
          }) to my ${bagWordT}.`
        : typedRemove
        ? `Remove SKU ${pick.sku} from my ${bagWordT}.`
        : `Change the quantity of SKU ${pick.sku} to ${
            num[(typedQty as RegExpMatchArray)[2].toLowerCase()] ||
            Number((typedQty as RegExpMatchArray)[2]) ||
            1
          }.`;

      return this.applyStorefrontCartCommand(
        tenantId,
        sessionId,
        sentence,
        journeyState,
        projectConfig,
        uiToolCalls,
        conversation,
        emit
      );
    }

    const current = journeyState?.quoteId
      ? await this.quoteService.get(journeyState.quoteId, tenantId).catch(() => null)
      : null;
    const qty = new Map<string, number>();
    for (const l of current?.lines || []) {
      if (l?.sku) qty.set(String(l.sku).toUpperCase(), Math.max(1, Number(l.quantity) || 1));
    }

    const key = (add?.[1] || remove?.[1] || change?.[1] || '').toUpperCase();
    const touched: string[] = [];
    if (add) {
      qty.set(key, (qty.get(key) || 0) + Math.max(1, Number(add[2]) || 1));
      touched.push(key);
    } else if (addMany) {
      for (const m of addMany[1].matchAll(/(\S+) \(qty (\d+)\)/g)) {
        const k = m[1].toUpperCase();
        qty.set(k, (qty.get(k) || 0) + Math.max(1, Number(m[2]) || 1));
        touched.push(k);
      }
    } else if (remove) {
      qty.delete(key);
    } else if (change) {
      const n = Number(change[2]) || 0;
      if (n <= 0) qty.delete(key);
      else qty.set(key, n);
      touched.push(key);
    }

    const isCart = projectConfig?.commerceMode === 'cart';
    const bagWord = isCart ? 'bag' : 'quote';

    const items = [...qty.entries()].map(([sku, quantity]) => ({ sku, quantity }));
    if (!projectConfig?.pricing?.currency) {
      conversation.push({
        role: 'system',
        content: `[${bagWord.toUpperCase()} NOT UPDATED] Pricing configuration is not published for this tenant.`,
      });
      return false;
    }

    const quote = await this.quoteService.build({
      tenantId,
      title: current?.title || (isCart ? 'Your bag' : 'Your quote'),
      items,
      pricing: projectConfig.pricing,
    });

    if (!quote.lines?.length) {
      conversation.push({
        role: 'system',
        content: `[${bagWord.toUpperCase()} NOT UPDATED] SKU could not be priced from the catalogue.`,
      });
      return true;
    }

    journeyState.quoteId = quote.quoteId;
    const call: any = {
      id: `storefront_cart_${Date.now()}`,
      type: 'function',
      function: { name: 'updateQuote', arguments: JSON.stringify({ items }) },
      __quote: quote,
    };
    uiToolCalls.push(call);
    if (emit) emit('uiAction', { name: 'updateQuote', arguments: quote });

    const lines = quote.lines
      .map((l) => `${l.name} × ${l.quantity}${l.unitPrice !== null ? ` @ ${quote.symbol || ''}${l.unitPrice}` : ''}`)
      .join('; ');

    conversation.push({
      role: 'system',
      content: `[${bagWord.toUpperCase()} UPDATED — already applied, server-authoritative] ${bagWord} now: ${lines}. Total ${quote.symbol || ''}${quote.total} ${quote.currency || ''}. The updated ${bagWord} card is already on screen.`,
    });
    return true;
  }

  /**
   * Reads placed orders and attaches confirmed details to conversation.
   */
  async applyOrderPlacedContext(
    tenantId: string,
    text: string,
    conversation: any[],
    journeyState: any
  ): Promise<boolean> {
    const m = (text || '').trim().match(/^Payment received for order (\S+?)\.?$/i);
    if (!m) return false;
    const orderId = m[1];
    const order = await this.orderService.get(orderId, tenantId).catch(() => null);
    if (!order) {
      conversation.push({
        role: 'system',
        content: `[ORDER] No order ${orderId} exists for this business.`,
      });
      return true;
    }
    const quote = order.quoteId ? await this.quoteService.get(order.quoteId, tenantId).catch(() => null) : null;
    const lines = (quote?.lines || []).map((l: any) => `${l.name} × ${l.quantity}`).join('; ');
    const paid = order.status === 'paid';
    if (paid) journeyState.quoteId = null;

    conversation.push({
      role: 'system',
      content: `[ORDER ${paid ? 'PLACED' : 'PENDING'}] Order ${order.orderId} — status ${order.status}, total ${quote?.symbol || ''}${order.total} ${order.currency || ''}${lines ? `, items: ${lines}` : ''}.`,
    });
    return true;
  }

  /**
   * Cross-sell styling directive for cart completion.
   */
  crossSellDirective(
    commerceMode: string | undefined,
    lastUserText: string,
    quote: any,
    journeyState: any
  ): string | null {
    if (commerceMode !== 'cart') return null;
    const t = (lastUserText || '').toLowerCase();
    if (
      /\b(check\s?out|checkout|pay|purchase|buy now|that'?s all|thats all|just (this|these|that)|nothing else|no (thanks|more)|i'?m done|im done|ready to (pay|buy|check)|place (the )?order|proceed to)\b/.test(
        t
      )
    ) {
      return null;
    }

    const skus = (quote?.lines || []).map((l: any) => String(l.sku || '')).filter(Boolean).sort();
    const sig = skus.join('|');
    if (!sig) return null;
    if (journeyState.crossSellSig === sig) return null;
    journeyState.crossSellSig = sig;

    const cats = [...new Set((quote?.lines || []).map((l: any) => String(l.category || '').trim()).filter(Boolean))];
    journeyState.crossSellFor = sig;
    journeyState.crossSellRetries = 0;
    journeyState.crossSellExcludeCats = cats;
    journeyState.crossSellExcludeNames = (quote?.lines || [])
      .map((l: any) => String(l.name || '').trim().toLowerCase())
      .filter(Boolean);

    return `ITEM ADDED TO THE BAG — recommend complementary products from other categories.`;
  }

  /**
   * Filters cross-sell cards so duplicate items/categories already in the bag are omitted.
   */
  applyCrossSellFilter(call: any, journeyState: any): boolean {
    const leaf = (c: unknown): string =>
      String(c || '')
        .split(/[>\/|,]/)
        .pop()!
        .trim()
        .toLowerCase()
        .replace(/s\b/g, '')
        .trim();

    let args: any = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return false;
    }

    const prods = args?.products;
    if (!Array.isArray(prods) || !prods.length) return false;

    const badCats = new Set((journeyState.crossSellExcludeCats || []).map(leaf).filter(Boolean));
    const badNames = new Set(
      (journeyState.crossSellExcludeNames || []).map((n: string) => String(n).trim().toLowerCase())
    );

    const kept = prods.filter((p: any) => {
      const cl = leaf(p?.category);
      const nm = String(p?.name || '').trim().toLowerCase();
      if (cl && badCats.has(cl)) return false;
      if (nm && badNames.has(nm)) return false;
      return true;
    });

    if (kept.length) {
      args.products = kept;
      call.function.arguments = JSON.stringify(args);
      journeyState.crossSellFor = null;
      return false;
    }
    return true;
  }

  /**
   * Resolves shopper size from text or dimensions.
   */
  resolveShopperSize(intent: any, messages: any[]): string | null {
    const WORD: Record<string, string> = {
      xs: 'XS', 'extra small': 'XS', s: 'S', small: 'S', m: 'M', med: 'M', medium: 'M',
      l: 'L', large: 'L', xl: 'XL', 'x-large': 'XL', 'extra large': 'XL',
      xxl: 'XXL', 'xx-large': 'XXL', '2xl': 'XXL', '3xl': 'XXXL', xxxl: 'XXXL',
    };
    const norm = (raw: string): string | null => {
      const s = String(raw || '').trim().toLowerCase();
      if (!s) return null;
      if (WORD[s]) return WORD[s];
      if (/^(x{0,3})[sml]$|^x{1,3}l$/.test(s)) return s.toUpperCase();
      const w = s.match(/\b(2[0-9]|3[0-9]|4[0-4])\b/);
      if (w) return w[1];
      return null;
    };

    for (const [k, v] of Object.entries(intent?.dimensions || {})) {
      if (/size|fit/i.test(k)) {
        const n = norm(String(v));
        if (n) return n;
      }
    }

    const text = (messages || [])
      .filter((m) => m?.role === 'user')
      .map((m) => (typeof m?.content === 'string' ? m.content : ''))
      .join(' ');
    const m = text
      .toLowerCase()
      .match(/\b(xs|s|m|l|xl|xxl|extra small|small|medium|large|x-large|extra large|xx-large|2[0-9]|3[0-9]|4[0-4])\b/);
    return m ? norm(m[1]) : null;
  }

  /**
   * Preselects matching size in product cards.
   */
  applySizePreselect(call: any, shopperSize: string | null): void {
    if (!shopperSize || call?.function?.name !== 'showItems') return;
    let args: any = {};
    try {
      args = JSON.parse(call.function.arguments || '{}');
    } catch {
      return;
    }
    const prods = args?.products;
    if (!Array.isArray(prods) || !prods.length) return;
    const want = shopperSize.toUpperCase();
    let changed = false;
    for (const p of prods) {
      const sizes = Array.isArray(p?.sizes) ? p.sizes : [];
      const match = sizes.find((s: any) => String(s).trim().toUpperCase() === want);
      if (match) {
        p.recommendedSize = match;
        changed = true;
      }
    }
    if (changed) call.function.arguments = JSON.stringify(args);
  }
}
