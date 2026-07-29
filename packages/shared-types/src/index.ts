export interface TenantConfig {
  tenantId: string;
  slug: string;
  companyName: string;
  domain: string;
  theme: {
    primaryColor: string;
    accentColor: string;
    fontFamily: string;
    logoUrl?: string;
    visualizerEnabled?: boolean;
  };
  scope: {
    rooms: string[];
    finishes: string[];
    categories?: string[];
  };
  pricing: {
    currency: string;
    symbol: string;
    taxRate: number;
    discountRate: number;
  };
  persona: {
    systemName: string;
    systemPromptOverrides: string;
  };
}

export interface User {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: 'admin' | 'buyer' | 'cs' | 'rep';
  createdAt: Date;
}

export interface BomItem {
  sku: string;
  name: string;
  price: number;
  quantity: number;
  category: string;
  isRequired: boolean;
  reason?: string;
}

export interface Quote {
  id: string;
  tenantId: string;
  userId: string;
  quoteTitle: string;
  jobId: string;
  status: 'draft' | 'ordered' | 'abandoned';
  totals: {
    subtotal: number;
    discount: number;
    gst: number;
    total: number;
  };
  bom: BomItem[];
  installationSummary?: string;
  warrantySummary?: string;
  createdAt: Date;
}

export type ConnectorType = 'shopify' | 'commercetools' | 'sap_erp' | 'netsuite' | 'hubspot' | 'salesforce_crm' | 'stripe';

export interface IntegrationConnection {
  id: string;
  tenantId: string;
  name: string;
  type: ConnectorType;
  isActive: boolean;
  credentials: {
    apiUrl: string;
    apiKey?: string;
    apiSecret?: string;
    authToken?: string;
    clientId?: string;
    orgId?: string;
  };
  lastSyncedAt?: Date;
}

export interface SyncCatalogPayload {
  tenantId: string;
  connectionId: string;
  limit?: number;
}

export interface SyncResult {
  success: boolean;
  itemsProcessed: number;
  errors: string[];
}

export interface PushLeadPayload {
  tenantId: string;
  quoteId: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  bom: BomItem[];
  totals: {
    subtotal: number;
    discount: number;
    gst: number;
    total: number;
  };
  conversationTranscriptUrl?: string;
}

export interface PushLeadResult {
  success: boolean;
  externalLeadId: string;
  crmUrl?: string;
}

export interface CreateCheckoutPayload {
  tenantId: string;
  quoteId: string;
  bom: BomItem[];
  currency: string;
  successUrl: string;
  cancelUrl: string;
}

export interface CreateCheckoutResult {
  success: boolean;
  checkoutUrl: string;
  externalOrderId?: string;
}

// ── RBAC policy (P0-02) ──
export * from "./rbac";
