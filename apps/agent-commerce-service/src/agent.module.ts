import { Module } from '@nestjs/common';
import { JourneyAXController } from './agent.controller';
import { AgentService } from './agent.service';
import { JourneyCoordinator } from './orchestration/journey-coordinator';
import { QuoteService } from './commerce/quote.service';
import { RosterService } from './commerce/roster.service';
import { OrderService } from './commerce/order.service';
import { PaymentRecoveryWorkerService } from './commerce/payment-recovery-worker.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { WhatsAppService } from './commerce/whatsapp.service';
import { CanonicalRuntimeAdapter } from './runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from './runtime/tenant-runtime-activation.router';
import { WhatsappController } from './whatsapp.controller';

import { CartController } from './commerce/cart.controller';
import { OperationalDesksController } from './desks/operational-desks.controller';

@Module({
  controllers: [JourneyAXController, WhatsappController, OperationalDesksController, CartController],
  providers: [
    AgentService,
    JourneyCoordinator,
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    QuoteService,
    OrderService,
    PaymentRecoveryWorkerService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
  ],
  exports: [
    AgentService,
    JourneyCoordinator,
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    QuoteService,
    OrderService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
  ],
})
export class AgentModule {}
