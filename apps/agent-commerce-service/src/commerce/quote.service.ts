/**
 * QuoteService (P0-04) — the deterministic, server-authoritative quote engine.
 *
 * This is the fix for "the LLM/client decides the price". The agent hands us
 * only { sku, quantity }; we rehydrate the real price from the catalogue
 * (product-service pricebook), apply the PROJECT'S configured tax + discount
 * (project.pricing — never a hardcoded per-tenant rate), run config-driven
 * validation, and persist a versioned, expiring quote. Nothing monetary comes
 * from the model or the browser.
 */
import { resolveServiceUrl, priceCommerceLines } from '@journeyax/shared-types';
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { randomUUID, createHash } from 'crypto';
import { Collection, Db } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import {
  BusinessPackRelease,
  BusinessPackLoader,
  getSpacePlannerExtension,
  validateRoomLayoutAgainstPack,
  validateAccessoryCompatibilityAgainstPack,
  calculateMaterialQuantityFromPack,
} from '@journeyax/business-pack';
import { Quote, QuoteLine, QuoteLineInput } from './quote.types';

const QUOTES = 'quotes';
const QUOTE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // quotes valid for 7 days

export interface BuildQuoteArgs {
  tenantId: string;
  environmentId?: string;
  principalId?: string;
  sessionId?: string;
  idempotencyKey?: string;
  title?: string;
  items: QuoteLineInput[];
  roomType?: string;
  plannerContext?: { roomType?: string; areaM2?: number; [key: string]: any };
  pack?: BusinessPackRelease;
  packLoader?: BusinessPackLoader;
  installationSummary?: string;
  warrantySummary?: string;
  pricing: { currency: string; symbol: string; taxRate: number; discountRate: number };
}

@Injectable()
export class QuoteService {
  private col: Collection<Quote> | null = null;
  private readonly productServiceUrl = resolveServiceUrl('PRODUCT_SERVICE_URL', process.env.PRODUCT_SERVICE_URL, 'http://localhost:8083');

  constructor() {}

  private async getCol(): Promise<Collection<Quote> | null> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    const { db }: { db: Db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
    this.col = db.collection<Quote>(QUOTES);
    await this.col.createIndex({ quoteId: 1 }, { unique: true });
    await this.col
      .createIndex({ tenantId: 1, environmentId: 1, principalId: 1, idempotencyKey: 1 }, { unique: true, partialFilterExpression: { idempotencyKey: { $type: 'string' } } });
    return this.col;
  }

  /** Authoritative price/stock lookup from the catalogue (internal-key protected). */
  private async fetchPricebook(tenantId: string, skus: string[]): Promise<{
    items: Array<{ sku: string; name: string; price: number | null; category?: string; imageUrl?: string; url?: string; inStock?: boolean; currency?: string; leadTimeDays?: number }>;
    missing: string[];
  }> {
    try {
      const res = await fetch(
        `${this.productServiceUrl}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ skus }),
          redirect: 'error', signal: AbortSignal.timeout(15_000),
        },
      );
      if (!res.ok) return { items: [], missing: skus };
      const data: any = await res.json();
      return { items: data.items || [], missing: data.missing || [] };
    } catch {
      return { items: [], missing: skus };
    }
  }

  /** Build + persist an authoritative quote from proposed SKUs/quantities. */
  async build(args: BuildQuoteArgs): Promise<Quote> {
    const { tenantId, pricing } = args;
    const rawIdempotencyKey = args.idempotencyKey ? String(args.idempotencyKey).trim() : '';
    if (!tenantId || !args.environmentId || !args.principalId) throw new HttpException('A verified quote owner and environment are required.', HttpStatus.UNAUTHORIZED);
    if (!Array.isArray(args.items) || args.items.length < 1 || args.items.length > 200) throw new HttpException('A bounded list of items is required.', HttpStatus.BAD_REQUEST);
    const rawItems = args.items.map(item => {
      const quantity = item?.quantity ?? 1;
      if (typeof item?.sku !== 'string' || !item.sku.trim() || item.sku.length > 200 || !Number.isSafeInteger(quantity) || quantity <= 0 || quantity > 1_000_000) throw new HttpException('A catalogue SKU and positive whole quantity are required.', HttpStatus.BAD_REQUEST);
      return { ...item, sku: item.sku.trim(), quantity };
    });
    if (new Set(rawItems.map(item => item.sku)).size !== rawItems.length) throw new HttpException('Combine duplicate SKU quantities before requesting a quote.', HttpStatus.BAD_REQUEST);
    const inputHash = createHash('sha256').update(JSON.stringify([rawItems, args.sessionId, args.title, args.plannerContext, args.roomType, pricing])).digest('hex');
    const col = await this.getCol();
    if (!col) throw new HttpException('Durable quote storage is unavailable.', HttpStatus.SERVICE_UNAVAILABLE);
    const requestScope = { tenantId, environmentId: args.environmentId, principalId: args.principalId, idempotencyKey: rawIdempotencyKey };
    if (rawIdempotencyKey) {
      const existing = await col.findOne(requestScope, { projection: { _id: 0 } });
      if (existing) {
        if (existing.inputHash !== inputHash) throw new HttpException('Quote idempotency key conflicts with another request.', HttpStatus.CONFLICT);
        return existing;
      }
    }

    const skus = rawItems.map((i) => String(i.sku).trim());
    const book = await this.fetchPricebook(tenantId, skus);
    const bySku = new Map(book.items.map((i) => [i.sku, i]));

    const errors: string[] = [];
    const warnings: string[] = [];

    // Load active Business Pack space-planner extension for server-side rule enforcement
    let pack: BusinessPackRelease | null | undefined = args.pack;
    if (!pack) {
      try {
        const loader = args.packLoader || new BusinessPackLoader();
        // Strict production pack only: never fall back to test pack in production quoting
        pack = await loader.loadPublished(tenantId, args.environmentId as any).catch(() => null);
      } catch {
        pack = null;
      }
    }
    const plannerExt = pack ? getSpacePlannerExtension(pack) : null;
    const effectiveRoomType = (args.roomType || args.plannerContext?.roomType || '').toLowerCase().trim();
    const isPlannerQuote = Boolean(effectiveRoomType || args.plannerContext);

    // Fail closed: if planner quoting is invoked and active production pack is unavailable
    if (isPlannerQuote && (!pack || !plannerExt)) {
      throw new HttpException(
        `Active production Business Pack space planner is unavailable for tenant '${tenantId}'. Planner quoting fails closed.`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    if (isPlannerQuote && plannerExt) {
      if (!effectiveRoomType) {
        throw new HttpException(
          `Configured room type is required for space planner quoting for tenant '${tenantId}' - failing closed`,
          HttpStatus.BAD_REQUEST,
        );
      }

      // 1. Enforce Room Layout Isolation server-side
      const layoutErrs = validateRoomLayoutAgainstPack(rawItems, effectiveRoomType, plannerExt);
      errors.push(...layoutErrs);

      // 2. Enforce Accessory System Compatibility server-side
      const accCheck = validateAccessoryCompatibilityAgainstPack(
        rawItems,
        effectiveRoomType,
        plannerExt
      );
      if (!accCheck.valid) {
        errors.push(...accCheck.errors);
      }

      // 3. Enforce Calculation Formulas (e.g. wall lining area calculation)
      const areaM2 = args.plannerContext?.areaM2;
      if (typeof areaM2 === 'number' && areaM2 > 0) {
        const calculatedQty = calculateMaterialQuantityFromPack(areaM2, 'lining', plannerExt);
        for (const it of rawItems) {
          const itemCat = String((it as any).category || bySku.get(String(it.sku).trim())?.category || '').toLowerCase();
          if (itemCat === 'lining') {
            const currentQty = it.quantity;
            if (currentQty < calculatedQty) {
              it.quantity = calculatedQty;
            }
          }
        }
      }
    }

    const lines: QuoteLine[] = rawItems.map((it) => {
      const sku = String(it.sku).trim();
      const p = bySku.get(sku);
      const quantity = it.quantity;
      const unitPrice = p && Number.isFinite(p.price) && p.price! >= 0 ? p.price : null;
      if (!p) errors.push(`SKU ${sku} is not in the catalogue and was not priced.`);
      else if (unitPrice === null) warnings.push(`${p.name} (${sku}) is price-on-request.`);
      if (p && p.inStock === false) warnings.push(`${p.name} (${sku}) is currently out of stock.`);
      return {
        sku,
        name: p?.name || sku,
        unitPrice,
        quantity,
        lineTotal: unitPrice !== null ? Number((unitPrice * quantity).toFixed(2)) : 0,
        sourceOfPrice: unitPrice !== null ? 'catalogue' : 'unavailable',
        inStock: typeof p?.inStock === 'boolean' ? p.inStock : undefined,
        category: p?.category,
        imageUrl: p?.imageUrl,
        url: p?.url,
        reason: it.reason,
        required: it.required,
        leadTimeDays: typeof p?.leadTimeDays === 'number' ? p.leadTimeDays : undefined,
      };
    });

    /* Production window for the whole order: the longest of its made-to-order
       lines, since the order is not finished until its slowest item is. Read
       from the catalogue via the pricebook — never quoted by the model. */
    const windows = lines.map((l) => l.leadTimeDays).filter((d): d is number => typeof d === 'number');
    const leadTimeDays = windows.length ? Math.max(...windows) : undefined;
    const leadTimeSummary = leadTimeDays
      ? `Made to order — allow about ${leadTimeDays} business days for production before dispatch.`
      : undefined;

    const priced = priceCommerceLines(lines.map(line => ({ ...line, currency: book.items.find(item => item.sku === line.sku)?.currency })), pricing);
    priced.validation.errors.push(...errors);
    priced.validation.warnings.push(...warnings);
    priced.validation.ok = priced.validation.errors.length === 0;

    const now = Date.now();
    const quote: Quote = {
      quoteId: 'q_' + randomUUID().replace(/-/g, ''),
      tenantId,
      environmentId: args.environmentId,
      principalId: args.principalId,
      sessionId: args.sessionId,
      idempotencyKey: rawIdempotencyKey || undefined,
      inputHash,
      version: 1,
      title: args.title || 'Your Quote',
      ...priced,
      status: 'draft',
      leadTimeDays,
      leadTimeSummary,
      installationSummary: args.installationSummary,
      warrantySummary: args.warrantySummary,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    };

    try { await col.insertOne({ ...quote }); }
    catch (error: any) {
      if (rawIdempotencyKey && error?.code === 11000) {
        const existing = await col.findOne(requestScope, { projection: { _id: 0 } });
        if (existing?.inputHash === inputHash) return existing;
        throw new HttpException('Quote idempotency key conflicts with another request.', HttpStatus.CONFLICT);
      }
      throw new HttpException('The quote could not be saved. Checkout is unavailable.', HttpStatus.SERVICE_UNAVAILABLE);
    }

    return quote;
  }

  async get(quoteId: string, tenantId?: string, owner?: { environmentId: string; principalId: string }): Promise<Quote | null> {
    const col = await this.getCol();
    if (!col) return null;
    const filter: any = { quoteId };
    if (tenantId) filter.tenantId = tenantId.toLowerCase().trim();
    if (owner) Object.assign(filter, { environmentId: owner.environmentId, principalId: owner.principalId });
    return col.findOne(filter);
  }

  async markStatus(quoteId: string, status: Quote['status'], tenantId: string, environmentId?: string, version?: number, principalId?: string): Promise<void> {
    const col = await this.getCol();
    if (col && tenantId) await col.updateOne({ quoteId, tenantId, ...(environmentId ? { environmentId } : {}), ...(version !== undefined ? { version } : {}), ...(principalId ? { principalId } : {}) }, { $set: { status } });
  }
}
