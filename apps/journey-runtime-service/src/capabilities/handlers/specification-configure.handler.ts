import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface SpecificationConfigureInput {
  fixtureId?: string;
  finish?: string;
  spaceType?: string;
  options?: Record<string, any>;
}

export class SpecificationConfigureHandler implements NativeCapabilityHandler {
  async execute(input: SpecificationConfigureInput, ctx: ExecutionContext): Promise<any> {
    const configuredSpec = {
      fixtureId: input.fixtureId || 'caroma-spec-01',
      finish: input.finish || 'matte black',
      spaceType: input.spaceType || 'ensuite',
      status: 'configured',
      configuredAt: new Date().toISOString(),
    };

    return {
      configuredSpec,
      status: 'success',
    };
  }
}
