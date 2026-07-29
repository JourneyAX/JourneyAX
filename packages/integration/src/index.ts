/**
 * @journeyax/integration — the Integration/Adapter layer.
 *
 * Public surface: import ports + the registry from here. Domain code and the
 * agent-runtime should depend ONLY on the ports and `adapterRegistry`, never on
 * a concrete adapter class.
 *
 *   import { adapterRegistry, CommercePort } from '@journeyax/integration';
 *   const commerce = adapterRegistry.getCommerce(tenantId);
 *   const products = await commerce.searchProducts({ tenantId }, { query });
 */
export * from './ports';
export * from './registry';

// Concrete adapters are exported for wiring/registration only (not for direct use):
export { StandaloneCommerceAdapter } from './adapters/commerce/standalone.commerce.adapter';
export { ShopifyCommerceAdapter } from './adapters/commerce/shopify.commerce.adapter';
export { SalesforceCrmAdapter } from './adapters/crm/salesforce.crm.adapter';
export { StandaloneKnowledgeAdapter } from './adapters/knowledge/standalone.knowledge.adapter';
export { CommercetoolsKnowledgeAdapter } from './adapters/knowledge/commercetools.knowledge.adapter';
export { ConfigBusinessAdapter } from './adapters/business/config.business.adapter';
