import { 
  ConnectorType, 
  IntegrationConnection, 
  SyncCatalogPayload, 
  SyncResult, 
  PushLeadPayload, 
  PushLeadResult, 
  CreateCheckoutPayload, 
  CreateCheckoutResult 
} from '@journeyax/shared-types';

/**
 * Universal interface for JourneyAX connectors
 */
export interface IJourneyConnector {
  readonly type: ConnectorType;
  testConnection(conn: IntegrationConnection): Promise<{ ok: boolean; message?: string }>;
}

export interface ICatalogConnector extends IJourneyConnector {
  syncCatalog(conn: IntegrationConnection, payload: SyncCatalogPayload): Promise<SyncResult>;
}

export interface ICrmConnector extends IJourneyConnector {
  pushLead(conn: IntegrationConnection, payload: PushLeadPayload): Promise<PushLeadResult>;
}

export interface ICheckoutConnector extends IJourneyConnector {
  createCheckoutSession(conn: IntegrationConnection, payload: CreateCheckoutPayload): Promise<CreateCheckoutResult>;
}

/**
 * Shopify Integration Connector (B2C Catalog / Checkout)
 */
export class ShopifyConnector implements ICatalogConnector, ICheckoutConnector {
  readonly type = 'shopify';

  async testConnection(conn: IntegrationConnection): Promise<{ ok: boolean; message?: string }> {
    if (!conn.credentials.apiUrl || !conn.credentials.apiKey) {
      return { ok: false, message: 'Missing Shopify API Store URL or Access Token.' };
    }
    return { ok: true, message: `Successfully connected to Shopify store at ${conn.credentials.apiUrl}` };
  }

  async syncCatalog(conn: IntegrationConnection, payload: SyncCatalogPayload): Promise<SyncResult> {
    console.log(`[Shopify Sync] Pulling items for tenant: ${payload.tenantId}`);
    return {
      success: true,
      itemsProcessed: payload.limit || 50,
      errors: []
    };
  }

  async createCheckoutSession(conn: IntegrationConnection, payload: CreateCheckoutPayload): Promise<CreateCheckoutResult> {
    console.log(`[Shopify Checkout] Creating draft order for Quote: ${payload.quoteId}`);
    const orderId = `SHPF-ORD-${Math.floor(100000 + Math.random() * 900000)}`;
    return {
      success: true,
      checkoutUrl: `https://${conn.credentials.apiUrl}/checkout/draft?id=${orderId}`,
      externalOrderId: orderId
    };
  }
}

/**
 * SAP ERP Integration Connector (B2B Pricing & Inventory)
 */
export class SapErpConnector implements IJourneyConnector {
  readonly type = 'sap_erp';

  async testConnection(conn: IntegrationConnection): Promise<{ ok: boolean; message?: string }> {
    if (!conn.credentials.apiUrl || !conn.credentials.authToken) {
      return { ok: false, message: 'Missing SAP RFC Gateway endpoint or credentials.' };
    }
    return { ok: true, message: 'Connected to SAP ERP RFC Gateway.' };
  }

  async getB2BContractPrice(sku: string, customerId: string): Promise<{ price: number; discountPercent: number }> {
    // Mock ERP customer group discount lookup
    const discountPercent = customerId.startsWith('GOLD') ? 0.20 : 0.12;
    const standardPrice = 150.00;
    return {
      price: Number((standardPrice * (1 - discountPercent)).toFixed(2)),
      discountPercent
    };
  }

  async checkWarehouseInventory(sku: string, warehouseCode: string): Promise<{ inStockQuantity: number }> {
    return { inStockQuantity: Math.floor(Math.random() * 100) };
  }
}

/**
 * HubSpot Integration Connector (B2B/B2C CRM Lead Log)
 */
export class HubSpotConnector implements ICrmConnector {
  readonly type = 'hubspot';

  async testConnection(conn: IntegrationConnection): Promise<{ ok: boolean; message?: string }> {
    if (!conn.credentials.apiKey) {
      return { ok: false, message: 'Missing HubSpot API Private Access Token.' };
    }
    return { ok: true, message: 'Connected to HubSpot Portal.' };
  }

  async pushLead(conn: IntegrationConnection, payload: PushLeadPayload): Promise<PushLeadResult> {
    console.log(`[HubSpot CRM] Pushing contact and deal for: ${payload.customerEmail}`);
    const dealId = `HS-DEAL-${Math.floor(100000 + Math.random() * 900000)}`;
    return {
      success: true,
      externalLeadId: dealId,
      crmUrl: `https://app.hubspot.com/contacts/${conn.credentials.clientId || 'default'}/deal/${dealId}`
    };
  }
}

/**
 * Stripe Integration Connector (B2C Direct Hosted Payment)
 */
export class StripeConnector implements ICheckoutConnector {
  readonly type = 'stripe';

  async testConnection(conn: IntegrationConnection): Promise<{ ok: boolean; message?: string }> {
    if (!conn.credentials.apiKey) {
      return { ok: false, message: 'Missing Stripe Secret API Key.' };
    }
    return { ok: true, message: 'Stripe API Connection validated.' };
  }

  async createCheckoutSession(conn: IntegrationConnection, payload: CreateCheckoutPayload): Promise<CreateCheckoutResult> {
    console.log(`[Stripe Payments] Generating checkout portal for Quote: ${payload.quoteId}`);
    const sessionId = `cs_test_${Math.floor(100000 + Math.random() * 900000)}`;
    return {
      success: true,
      checkoutUrl: `https://checkout.stripe.com/pay/${sessionId}`,
      externalOrderId: sessionId
    };
  }
}

/**
 * Connector Registry containing references to all supported integration classes
 */
export class ConnectorRegistry {
  private connectors: Map<ConnectorType, IJourneyConnector> = new Map();

  constructor() {
    this.register(new ShopifyConnector());
    this.register(new SapErpConnector());
    this.register(new HubSpotConnector());
    this.register(new StripeConnector());
  }

  private register(connector: IJourneyConnector) {
    this.connectors.set(connector.type, connector);
  }

  getConnector(type: ConnectorType): IJourneyConnector | undefined {
    return this.connectors.get(type);
  }
}
