import { Injectable } from '@nestjs/common';

export const STANDARD_TOOL_SCHEMAS: Record<string, {
  inputSchema: Record<string, any>;
  outputSchema: Record<string, any>;
  sideEffect: 'read' | 'write' | 'transactional';
  risk: 'low' | 'medium' | 'high' | 'critical';
  requiresApproval: boolean;
  idempotencyRequired: boolean;
}> = {
  products: {
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { items: { type: 'array' }, total: { type: 'number' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  product_catalog_search: {
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { items: { type: 'array' }, total: { type: 'number' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  catalog_search: {
    inputSchema: { type: 'object', properties: { query: { type: 'string' }, category: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { items: { type: 'array' }, total: { type: 'number' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  inventory_check: {
    inputSchema: { type: 'object', properties: { skus: { type: 'array', items: { type: 'string' } } }, required: ['skus'] },
    outputSchema: { type: 'object', properties: { inventory: { type: 'array' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  accessories: {
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } }, required: ['sku'] },
    outputSchema: { type: 'object', properties: { accessories: { type: 'array' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  quote: {
    inputSchema: { type: 'object', properties: { items: { type: 'array' }, budget: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, totalCents: { type: 'number' } } },
    sideEffect: 'write', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  quote_create: {
    inputSchema: { type: 'object', properties: { items: { type: 'array' }, budget: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, totalCents: { type: 'number' } } },
    sideEffect: 'write', risk: 'medium', requiresApproval: false, idempotencyRequired: false,
  },
  createQuote: {
    inputSchema: { type: 'object', properties: { items: { type: 'array' }, budget: { type: 'number' } } },
    outputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, totalCents: { type: 'number' } } },
    sideEffect: 'write', risk: 'medium', requiresApproval: false, idempotencyRequired: false,
  },
  order_commit: {
    inputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'] },
    outputSchema: { type: 'object', properties: { orderId: { type: 'string' }, status: { type: 'string' } } },
    sideEffect: 'transactional', risk: 'high', requiresApproval: true, idempotencyRequired: true,
  },
  orderCommit: {
    inputSchema: { type: 'object', properties: { quoteId: { type: 'string' }, idempotencyKey: { type: 'string' } }, required: ['idempotencyKey'] },
    outputSchema: { type: 'object', properties: { orderId: { type: 'string' }, status: { type: 'string' } } },
    sideEffect: 'transactional', risk: 'high', requiresApproval: true, idempotencyRequired: true,
  },
  roster: {
    inputSchema: { type: 'object', properties: { rawText: { type: 'string' } }, required: ['rawText'] },
    outputSchema: { type: 'object', properties: { players: { type: 'array' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  teamColours: {
    inputSchema: { type: 'object', properties: { schoolOrTeam: { type: 'string' } }, required: ['schoolOrTeam'] },
    outputSchema: { type: 'object', properties: { colors: { type: 'array' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  customDesign: {
    inputSchema: { type: 'object', properties: { templateId: { type: 'string' }, designData: { type: 'object' } } },
    outputSchema: { type: 'object', properties: { previewUrl: { type: 'string' } } },
    sideEffect: 'write', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  installGuide: {
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { pdfUrl: { type: 'string' }, title: { type: 'string' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
  warranty: {
    inputSchema: { type: 'object', properties: { sku: { type: 'string' } } },
    outputSchema: { type: 'object', properties: { terms: { type: 'string' }, durationMonths: { type: 'number' } } },
    sideEffect: 'read', risk: 'low', requiresApproval: false, idempotencyRequired: false,
  },
};

@Injectable()
export class CapabilityRegistryService {
  getStandardToolSchema(toolId: string) {
    return STANDARD_TOOL_SCHEMAS[toolId] || null;
  }

  listStandardToolSchemas() {
    return STANDARD_TOOL_SCHEMAS;
  }

  hasToolSchema(toolId: string): boolean {
    return Boolean(STANDARD_TOOL_SCHEMAS[toolId]);
  }
}
