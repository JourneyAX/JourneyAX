import { Controller, Get } from '@nestjs/common';

/** Liveness only. It reads no setting and touches no store. */
@Controller()
export class HealthController {
  @Get(['health', 'api/v1/jax-iq/health'])
  health() {
    return { status: 'ok', service: 'jax-iq-service' };
  }
}
