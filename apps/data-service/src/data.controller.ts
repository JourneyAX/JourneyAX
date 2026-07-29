import { Controller, Post, Body } from '@nestjs/common';
import { IntegrationConnection, SyncCatalogPayload } from '@journeyax/shared-types';
import { ConnectorRegistry, ShopifyConnector } from '@journeyax/configurator-core';

@Controller('api/v1/data')
export class DataController {
  private registry = new ConnectorRegistry();

  @Post('sync')
  async syncCatalog(
    @Body() body: { connection: IntegrationConnection; limit?: number }
  ) {
    const conn = body.connection;
    const connector = this.registry.getConnector(conn.type);
    
    if (!connector) {
      return {
        success: false,
        errors: [`Connector for type '${conn.type}' is not registered.`]
      };
    }

    // Validate the credentials
    const testResult = await connector.testConnection(conn);
    if (!testResult.ok) {
      return {
        success: false,
        errors: [`Connection check failed: ${testResult.message}`]
      };
    }

    // Run simulated synchronization
    console.log(`[Data Sync] Synchronizing via ${conn.type.toUpperCase()} for tenant: ${conn.tenantId}`);
    
    return {
      success: true,
      itemsProcessed: body.limit || 50,
      errors: [],
      message: `Successfully synchronized ${body.limit || 50} catalog items into journeyax_products collection.`
    };
  }
}
