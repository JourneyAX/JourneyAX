import { Module } from '@nestjs/common';
import { JourneyAXController } from './agent.controller';
import { AgentService } from './agent.service';
import { QuoteService } from './commerce/quote.service';
import { RosterService } from './commerce/roster.service';
import { OrderService } from './commerce/order.service';
import { SchoolResearchService } from './commerce/school-research.service';
import { WhatsAppService } from './commerce/whatsapp.service';
import { WhatsappController } from './whatsapp.controller';

@Module({
  controllers: [JourneyAXController, WhatsappController],
  providers: [AgentService, QuoteService, OrderService, RosterService, SchoolResearchService, WhatsAppService],
})
export class AgentModule {}
