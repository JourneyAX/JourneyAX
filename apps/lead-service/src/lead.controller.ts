import { Controller, Post, Body } from '@nestjs/common';
import { PushLeadPayload } from '@journeyax/shared-types';

@Controller('api/v1/leads')
export class LeadController {
  @Post()
  pushLead(@Body() payload: PushLeadPayload) {
    console.log(`[Lead Service] Logging new commerce lead for: ${payload.customerEmail}`);
    console.log(`[Lead Service] Total BOM Value: $${payload.totals.total}`);

    const externalLeadId = `CRM-LEAD-${Math.floor(100000 + Math.random() * 900000)}`;
    const crmDomain = payload.tenantId.toLowerCase() === 'caroma' ? 'hubspot' : 'salesforce';

    return {
      success: true,
      externalLeadId,
      crmUrl: `https://app.${crmDomain}.com/deals/${externalLeadId}`,
      message: `Quote for ${payload.customerName} pushed successfully to ${crmDomain.toUpperCase()} CRM.`
    };
  }
}
