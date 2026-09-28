import { Module } from '@nestjs/common';
import { LeadController } from './lead.controller';
import { CrmConnectorBindingResolver } from './crm-binding-resolver';

@Module({
  controllers: [LeadController],
  providers: [CrmConnectorBindingResolver],
})
export class LeadModule {}
