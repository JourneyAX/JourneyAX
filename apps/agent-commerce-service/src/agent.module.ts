import { Module } from '@nestjs/common';
import { JourneyAXController } from './agent.controller';
import { AgentService } from './agent.service';
import { JourneyCoordinator } from './orchestration/journey-coordinator';
import { ConfigLoader } from './pipeline/config-loader';
import { SessionStore } from './pipeline/session-store';
import { ModelRouter } from './llm/model-router';
import { PolicyEnforcer } from './pipeline/policy-enforcer';
import { StorefrontCommerceService } from './commerce/storefront-commerce.service';
import { ResponseComposer } from './presentation/response-composer';
import { ToolDispatcher } from './orchestration/tool-dispatcher';
import { QuoteService } from './commerce/quote.service';
import { RosterService } from './commerce/roster.service';
import { OrderService } from './commerce/order.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { WhatsAppService } from './commerce/whatsapp.service';
import { CanonicalRuntimeAdapter } from './runtime/canonical-runtime.adapter';
import { TenantRuntimeActivationRouter } from './runtime/tenant-runtime-activation.router';
import { LegacyJourneyAdapter } from './legacy/legacy-journey-adapter';
import { WhatsappController } from './whatsapp.controller';

@Module({
  controllers: [JourneyAXController, WhatsappController],
  providers: [
    AgentService,
    JourneyCoordinator,
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    LegacyJourneyAdapter,
    ConfigLoader,
    SessionStore,
    ModelRouter,
    PolicyEnforcer,
    StorefrontCommerceService,
    ResponseComposer,
    ToolDispatcher,
    QuoteService,
    OrderService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
  ],
  exports: [
    AgentService,
    JourneyCoordinator,
    TenantRuntimeActivationRouter,
    CanonicalRuntimeAdapter,
    LegacyJourneyAdapter,
    ConfigLoader,
    SessionStore,
    ModelRouter,
    PolicyEnforcer,
    StorefrontCommerceService,
    ResponseComposer,
    ToolDispatcher,
    QuoteService,
    OrderService,
    RosterService,
    SchoolResearchService,
    WhatsAppService,
  ],
})
export class AgentModule {}
