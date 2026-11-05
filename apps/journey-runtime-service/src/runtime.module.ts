import { Module } from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { RuntimeController } from './runtime.controller';
import { HealthController } from './health.controller';
import { VisualsController } from './visuals.controller';
import { RuntimeService } from './runtime.service';
import { RuntimeAuthGuard } from './auth/auth.guard';
import { OutboxWorkerService } from './kernel/outbox-worker.service';
import { TurnApplicationService } from './kernel/turn-application.service';
import { CapabilityGateway } from './kernel/capability.gateway';
import { createMongoOkfKnowledgePortResolver } from './infrastructure/mongo-okf-knowledge.port';
import { createLegacyKnowledgePortResolver } from './infrastructure/legacy-knowledge.port';
import { createProductSemanticSearcher } from './infrastructure/product-semantic-search';
import { DeskIntakeWorkerService } from './desks/desk-intake-worker.service';

@Module({
  imports: [],
  controllers: [HealthController, RuntimeController, VisualsController],
  providers: [
    {
      provide: TurnApplicationService,
      useFactory: () => new TurnApplicationService(
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        new CapabilityGateway({
          vectorSearcher: createProductSemanticSearcher(),
          knowledgePortResolver: createMongoOkfKnowledgePortResolver(),
          legacyKnowledgePortResolver: createLegacyKnowledgePortResolver(),
        })
      ),
    },
    RuntimeService,
    OutboxWorkerService,
    DeskIntakeWorkerService,
    Reflector,
    RuntimeAuthGuard,
    {
      provide: APP_GUARD,
      useClass: RuntimeAuthGuard,
    },
  ],
  exports: [RuntimeService, OutboxWorkerService],
})
export class RuntimeModule {}
