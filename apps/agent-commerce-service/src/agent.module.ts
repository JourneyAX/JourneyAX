import { Module } from '@nestjs/common';
import { JourneyAXController } from './agent.controller';
import { AgentService } from './agent.service';
import { JourneyCoordinator } from './orchestration/journey-coordinator';
import { QuoteService } from './commerce/quote.service';
import { RosterService } from './commerce/roster.service';
import { OrderService } from './commerce/order.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { WhatsAppService } from './commerce/whatsapp.service';
import { CanonicalRuntimeAdapter } from './runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from './runtime/tenant-runtime-activation.router';
import { WhatsappController } from './whatsapp.controller';

import { CareController } from './care/care.controller';
import { CareService } from './care/care.service';

@Module({
  controllers: [JourneyAXController, WhatsappController, CareController],
  providers: [
    AgentService,
    JourneyCoordinator,
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    QuoteService,
    OrderService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
    CareService,
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
