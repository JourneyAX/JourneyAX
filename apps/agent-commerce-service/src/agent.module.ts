import { Module } from '@nestjs/common';
import { JourneyAXController } from './agent.controller';
import { AgentService } from './agent.service';
import { QuoteService } from './commerce/quote.service';
import { RosterService } from './commerce/roster.service';
import { OrderService } from './commerce/order.service';
import { SchoolResearchService } from './commerce/school-research.service';

@Module({
  controllers: [JourneyAXController],
  providers: [AgentService, QuoteService, OrderService, RosterService, SchoolResearchService],
})
export class AgentModule {}
