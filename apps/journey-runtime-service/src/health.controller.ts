import { Controller, Get, Query, Optional } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { OutboxWorkerService } from './kernel/outbox-worker.service';

@Controller()
export class HealthController {
  constructor(
    @Optional() private readonly outboxWorkerService?: OutboxWorkerService
  ) {}

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

  @Public()
  @Get('health/worker')
  async workerHealth(@Query('tenantId') tenantId?: string) {
    if (this.outboxWorkerService) {
      return this.outboxWorkerService.getHealthInfo(tenantId);
    }

    return {
      status: 'unhealthy',
      mode: 'unconfigured',
      worker: 'inactive',
      state: 'unconfigured',
      configurationFailure: 'OutboxWorkerService is not registered',
      lastSuccessfulPoll: null,
      leaseStatus: { activeLeases: 0 },
      metrics: { pending: 0, leased: 0, published: 0, deadLetter: 0 },
      timestamp: new Date().toISOString(),
    };
  }
}

