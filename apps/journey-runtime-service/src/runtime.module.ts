import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { RuntimeController } from './runtime.controller';
import { HealthController } from './health.controller';
import { RuntimeService } from './runtime.service';
import { RuntimeAuthGuard } from './auth/auth.guard';

@Module({
  imports: [],
  controllers: [HealthController, RuntimeController],
  providers: [
    RuntimeService,
    {
      provide: APP_GUARD,
      useClass: RuntimeAuthGuard,
    },
  ],
  exports: [RuntimeService],
})
export class RuntimeModule {}
