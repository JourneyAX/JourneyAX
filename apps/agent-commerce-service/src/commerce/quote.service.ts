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
import { Injectable } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Collection, Db } from 'mongodb';
import { connectToDatabase } from '@journeyax/database';
import { Quote, QuoteLine, QuoteLineInput } from './quote.types';

const DB_NAME = 'journeyx';
const QUOTES = 'quotes';
const QUOTE_TTL_MS = 1000 * 60 * 60 * 24 * 7; // quotes valid for 7 days

export interface BuildQuoteArgs {
  tenantId: string;
  sessionId?: string;
  title?: string;
  items: QuoteLineInput[];
  installationSummary?: string;
  warrantySummary?: string;
  pricing: { currency: string; symbol: string; taxRate: number; discountRate: number };
}

@Injectable()
export class QuoteService {
  private col: Collection<Quote> | null = null;

  constructor(
    private readonly productServiceUrl = process.env.PRODUCT_SERVICE_URL || 'http://localhost:8083',
  ) {}

  private async getCol(): Promise<Collection<Quote> | null> {
    if (this.col) return this.col;
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    const { db }: { db: Db } = await connectToDatabase(uri, DB_NAME);
    this.col = db.collection<Quote>(QUOTES);
    await this.col.createIndex({ quoteId: 1 }, { unique: true }).catch(() => {});
    return this.col;
  }

  /** Authoritative price/stock lookup from the catalogue (internal-key protected). */
  private async fetchPricebook(tenantId: string, skus: string[]): Promise<{
    items: Array<{ sku: string; name: string; price: number | null; category?: string; imageUrl?: string; url?: string; inStock: boolean; leadTimeDays?: number }>;
    missing: string[];
  }> {
    try {
      const res = await fetch(
        `${this.productServiceUrl}/api/v1/${encodeURIComponent(tenantId)}/products/pricebook`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Internal-Key': process.env.INTERNAL_API_KEY || '' },
          body: JSON.stringify({ skus }),
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
    const rawItems = (args.items || []).filter((i) => i && i.sku);
    const skus = rawItems.map((i) => String(i.sku).trim());
    const book = await this.fetchPricebook(tenantId, skus);
    const bySku = new Map(book.items.map((i) => [i.sku, i]));

    const errors: string[] = [];
    const warnings: string[] = [];
    const lines: QuoteLine[] = rawItems.map((it) => {
      const sku = String(it.sku).trim();
      const p = bySku.get(sku);
      const quantity = Math.max(1, Math.floor(Number(it.quantity) || 1));
      const unitPrice = p && typeof p.price === 'number' ? p.price : null;
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
        inStock: p ? p.inStock !== false : false,
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

    // Totals — computed here from config, never trusted from LLM/client.
    const subtotal = Number(lines.reduce((s, l) => s + l.lineTotal, 0).toFixed(2));
    const discountRate = Number(pricing.discountRate) || 0;
    const taxRate = Number(pricing.taxRate) || 0;
    const discount = Number((subtotal * discountRate).toFixed(2));
    const preTax = subtotal - discount;
    const tax = Number((preTax * taxRate).toFixed(2));
    const total = Number((preTax + tax).toFixed(2));

    const now = Date.now();
    const quote: Quote = {
      quoteId: 'q_' + randomUUID().replace(/-/g, ''),
      tenantId,
      sessionId: args.sessionId,
      version: 1,
      title: args.title || 'Your Quote',
      currency: pricing.currency || 'AUD',
      symbol: pricing.symbol || '$',
      lines,
      subtotal,
      discountRate,
      discount,
      taxRate,
      tax,
      total,
      validation: { ok: errors.length === 0, errors, warnings },
      status: 'draft',
      leadTimeDays,
      leadTimeSummary,
      installationSummary: args.installationSummary,
      warrantySummary: args.warrantySummary,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + QUOTE_TTL_MS).toISOString(),
    };

    const col = await this.getCol();
    if (col) await col.insertOne(quote).catch((e) => console.error('[QuoteService] persist failed', e));
    return quote;
  }

  async get(quoteId: string, tenantId?: string): Promise<Quote | null> {
    const col = await this.getCol();
    if (!col) return null;
    const filter: any = { quoteId };
    if (tenantId) filter.tenantId = tenantId; // tenant-scoped read (isolation)
    return col.findOne(filter);
  }

  async markStatus(quoteId: string, status: Quote['status']): Promise<void> {
    const col = await this.getCol();
    if (col) await col.updateOne({ quoteId }, { $set: { status } });
  }
}
