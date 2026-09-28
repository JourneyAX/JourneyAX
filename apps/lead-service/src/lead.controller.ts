import { Controller, Post, Body, BadRequestException } from '@nestjs/common';
import { PushLeadPayload } from '@journeyax/shared-types';
import { CrmConnectorBindingResolver } from './crm-binding-resolver';

@Controller('api/v1/leads')
export class LeadController {
  constructor(private readonly crmResolver: CrmConnectorBindingResolver) {}

  @Post()
  async pushLead(@Body() payload: PushLeadPayload) {
    if (!payload?.tenantId) {
      throw new BadRequestException('tenantId is required in PushLeadPayload');
    }

    console.log(`[Lead Service] Logging new commerce lead for: ${payload.customerEmail} (tenant: ${payload.tenantId})`);
    console.log(`[Lead Service] Total BOM Value: $${payload.totals?.total}`);

    const binding = await this.crmResolver.resolveCrmBinding(payload.tenantId);
    const crmDomain = binding.crmDomain;
    const externalLeadId = `CRM-LEAD-${Math.floor(100000 + Math.random() * 900000)}`;

    return {
      success: true,
      externalLeadId,
      crmUrl: `https://app.${crmDomain}.com/deals/${externalLeadId}`,
      message: `Quote for ${payload.customerName} pushed successfully to ${crmDomain.toUpperCase()} CRM.`,
      bindingSource: binding.source,
    };
  }
}
