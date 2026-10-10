import { NativeCapabilityHandler, ExecutionContext } from '@journeyax/capability-sdk';

export interface SpacePlannerInput {
  roomType?: string;
  spaceType?: string;
  room?: string;
  wallWidthMm?: number | string;
  installType?: 'trade' | 'diy' | string;
  finish?: string;
}

export class SpacePlannerHandler implements NativeCapabilityHandler {
  async execute(input: SpacePlannerInput, _ctx: ExecutionContext): Promise<any> {
    const rawRoom = String(input.roomType || input.spaceType || input.room || '').toLowerCase().trim();
    const wallWidthMm =
      typeof input.wallWidthMm === 'number' && input.wallWidthMm > 0
        ? input.wallWidthMm
        : Number(input.wallWidthMm) > 0
        ? Number(input.wallWidthMm)
        : undefined;

    const installType = input.installType === 'trade' || input.installType === 'diy' ? input.installType : undefined;
    const finish = typeof input.finish === 'string' && input.finish.trim() ? input.finish.trim() : undefined;

    if (!rawRoom) {
      return {
        status: 'needs_input',
        ok: false,
        missingInputs: ['roomType'],
        message: 'The published journey must supply the configured space type before opening the planner.',
      };
    }

    return {
      status: 'success',
      ok: true,
      roomType: rawRoom,
      wallWidthMm,
      installType,
      finish,
      message: `Space Planner launched for ${rawRoom}`,
    };
  }
}
