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
  async execute(input: SpacePlannerInput, ctx: ExecutionContext): Promise<any> {
    const rawRoom = String(input.roomType || input.spaceType || input.room || 'bathroom').toLowerCase().trim();
    const wallWidthMm =
      typeof input.wallWidthMm === 'number' && input.wallWidthMm > 0
        ? input.wallWidthMm
        : Number(input.wallWidthMm) > 0
        ? Number(input.wallWidthMm)
        : 2400;

    const installType = input.installType === 'trade' || input.installType === 'diy' ? input.installType : 'diy';
    const finish = typeof input.finish === 'string' && input.finish.trim() ? input.finish.trim() : 'standard';

    return {
      status: 'success',
      ok: true,
      roomType: rawRoom,
      wallWidthMm,
      installType,
      finish,
      message: `PlaceMakers Space Planner launched for ${rawRoom}`,
    };
  }
}
