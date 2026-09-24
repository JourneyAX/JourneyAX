import { Controller, Get } from '@nestjs/common';
import { Public } from './auth/auth.guard';

@Controller()
export class HealthController {
  @Public()
  @Get('health')
  rootHealth() {
    return {
      status: 'ok',
      service: 'journey-runtime-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Public()
  @Get('api/v1/health')
  apiHealth() {
    return {
      status: 'ok',
      service: 'journey-runtime-service',
      timestamp: new Date().toISOString(),
    };
  }
}
