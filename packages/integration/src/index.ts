/**
 * @journeyax/integration — the Integration/Adapter layer.
 *
 * @deprecated LEGACY MIGRATION SOURCE ONLY.
 * Activepieces is the authenticated external connector plane.
 * Direct connector adapters must NOT be imported or used by modern Journey Runtime.
 * Kept frozen for unmigrated tenant compatibility until all tenants have validated Business Packs.
 */
export * from './ports';
export * from './registry';

// Concrete adapters are legacy migration sources only:
export { StandaloneCommerceAdapter } from './adapters/commerce/standalone.commerce.adapter';
export { ShopifyCommerceAdapter } from './adapters/commerce/shopify.commerce.adapter';
export { SalesforceCrmAdapter } from './adapters/crm/salesforce.crm.adapter';
export { StandaloneKnowledgeAdapter } from './adapters/knowledge/standalone.knowledge.adapter';
export { CommercetoolsKnowledgeAdapter } from './adapters/knowledge/commercetools.knowledge.adapter';
export { ConfigBusinessAdapter } from './adapters/business/config.business.adapter';
