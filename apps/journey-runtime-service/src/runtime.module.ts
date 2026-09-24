import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeController } from './runtime.controller';
import { HealthController } from './health.controller';
import { RuntimeService } from './runtime.service';
import { RuntimeAuthGuard } from './auth/auth.guard';
import { OutboxWorkerService } from './kernel/outbox-worker.service';

@Module({
  imports: [],
  controllers: [HealthController, RuntimeController],
  providers: [
    RuntimeService,
    OutboxWorkerService,
    {
      provide: APP_GUARD,
      useClass: RuntimeAuthGuard,
    },
  ],
  exports: [RuntimeService, OutboxWorkerService],
})
export class RuntimeModule {}

