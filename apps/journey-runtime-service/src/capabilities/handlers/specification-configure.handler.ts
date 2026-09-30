import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';
import { connectToDatabase, COLLECTION_PRODUCTS } from '@journeyax/database';

export interface SpecificationConfigureInput {
  fixtureId?: string;
  finish?: string;
  spaceType?: string;
  options?: Record<string, any>;
}

export interface SpecificationConnectorAdapter {
  configureSpecification(input: SpecificationConfigureInput, ctx: ExecutionContext): Promise<any>;
}

export class SpecificationConfigureHandler implements NativeCapabilityHandler {
  constructor(
    private readonly specAdapter?: SpecificationConnectorAdapter,
    private readonly inMemoryFixtures?: any[]
  ) {}

  async execute(input: SpecificationConfigureInput, ctx: ExecutionContext): Promise<any> {
    const tenantId = ctx.tenantId;

    if (!input.fixtureId) {
      throw new Error('[SpecificationConfigureHandler] fixtureId is required for specification configuration');
    }

    // 1. Explicitly configured tenant-scoped connector adapter
    if (this.specAdapter) {
      return this.specAdapter.configureSpecification(input, ctx);
    }

    // 2. Injected test fixture catalog
    if (this.inMemoryFixtures) {
      const fixture = this.inMemoryFixtures.find(
        (f) => f.fixtureId === input.fixtureId || f.id === input.fixtureId || f.sku === input.fixtureId
      );
      if (!fixture) {
        throw new Error(
          `[SpecificationConfigureHandler] Fixture '${input.fixtureId}' not found in fixture catalog`
        );
      }
      return {
        configuredSpec: {
          fixtureId: input.fixtureId,
          finish: input.finish || fixture.defaultFinish || '',
          spaceType: input.spaceType || fixture.spaceType || '',
          options: input.options || {},
          status: 'configured',
          configuredAt: new Date().toISOString(),
        },
        status: 'success',
      };
    }

    // 3. Durable, authoritative platform repository
    const uri = process.env.MONGODB_URI;
    if (uri) {
      const { db } = await connectToDatabase(uri, process.env.MONGODB_DB_NAME || 'journeyx');
      const fixture = await db.collection(COLLECTION_PRODUCTS).findOne({
        projectId: tenantId,
        $or: [{ sku: input.fixtureId }, { id: input.fixtureId }],
      });

      if (!fixture) {
        throw new Error(
          `[SpecificationConfigureHandler] Fixture '${input.fixtureId}' not found in catalog for tenant '${tenantId}'`
        );
      }

      return {
        configuredSpec: {
          fixtureId: input.fixtureId,
          finish: input.finish || '',
          spaceType: input.spaceType || '',
          options: input.options || {},
          status: 'configured',
          configuredAt: new Date().toISOString(),
        },
        status: 'success',
      };
    }

    // 4. Missing bindings must fail closed
    throw new Error(
      `[SpecificationConfigureHandler] Missing authoritative specification connector adapter or platform repository for tenant '${tenantId}' - failing closed`
    );
  }
}
