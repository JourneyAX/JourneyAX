import { Controller, Get, Query, Param, Optional, Inject } from '@nestjs/common';
import { Public } from './auth/auth.guard';
import { OutboxWorkerService } from './kernel/outbox-worker.service';
import { RuntimeService } from './runtime.service';

@Controller()
export class HealthController {
  constructor(
    @Optional() private readonly outboxWorkerService?: OutboxWorkerService,
    @Optional() @Inject(RuntimeService) private readonly runtimeService?: RuntimeService
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

  @Public()
  @Get('api/v1/runtime/engine-mode/:tenantId')
  async getEngineMode(
    @Param('tenantId') tenantId: string,
    @Query('environmentId') environmentId?: string,
    @Query('env') env?: string
  ) {
    const targetEnv = (environmentId || env || 'production') as any;
    if (this.runtimeService) {
      return this.runtimeService.getEngineMode(tenantId, targetEnv);
    }

    return {
      status: 'unconfigured',
      tenantId,
      environmentId: targetEnv,
      engineMode: 'rule-based',
      toolCount: 0,
      availableTools: [],
    };
  }
}

