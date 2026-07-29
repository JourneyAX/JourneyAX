/**
 * SalesforceCrmAdapter — external CRM (skeleton).
 *
 * Implements CrmPort against Salesforce (Sales/Service Cloud). Selected when a
 * tenant sets crm platform = 'salesforce'. Use `ctx.connection` for the OAuth
 * token + instance URL. Stubbed for now.
 *
 * Pair with a `HubSpotCrmAdapter` and a `StandaloneCrmAdapter` (internal
 * customer-service) following the same shape.
 */
import { AdapterContext, AdapterMeta, CrmContact, CrmPort } from '../../ports';

export class SalesforceCrmAdapter implements CrmPort {
  readonly meta: AdapterMeta = { domain: 'crm', platform: 'salesforce' };

  async upsertContact(_ctx: AdapterContext, _contact: CrmContact): Promise<{ contactId: string }> {
    // TODO: sObject upsert on Contact by Email
    throw new Error('SalesforceCrmAdapter.upsertContact not implemented');
  }

  async pushLead(
    _ctx: AdapterContext,
    _lead: { contact: CrmContact; summary: string; valueCents?: number },
  ): Promise<{ leadId: string; crmUrl?: string }> {
    // TODO: create Lead/Opportunity
    throw new Error('SalesforceCrmAdapter.pushLead not implemented');
  }

  async createCase(
    _ctx: AdapterContext,
    _c: { contactId: string; subject: string; body: string },
  ): Promise<{ caseId: string }> {
    // TODO: create Case
    throw new Error('SalesforceCrmAdapter.createCase not implemented');
  }

  async getCustomer(_ctx: AdapterContext, _id: string): Promise<CrmContact | null> {
    // TODO: query Contact
    throw new Error('SalesforceCrmAdapter.getCustomer not implemented');
  }

  async getSegments(_ctx: AdapterContext, _contactId: string): Promise<string[]> {
    // TODO: read campaign/segment membership
    throw new Error('SalesforceCrmAdapter.getSegments not implemented');
  }
}
