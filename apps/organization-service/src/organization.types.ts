/**
 * Organization Service — Domain Types
 *
 * Organization is just a billing/naming container.
 * It holds no product data, no user data, no config.
 *
 * ALL data lives in Projects (see project-service).
 *
 * Org → [projectId, projectId, ...]  (just references)
 */

export type OrgStatus = 'active' | 'suspended' | 'trial' | 'inactive';
export type OrgPlan   = 'starter' | 'growth' | 'enterprise' | 'custom';

export interface Organization {
  orgId: string;           // "org-gwa"
  name: string;            // "GWA Group Limited"
  domain: string;          // "caroma.com.au"
  status: OrgStatus;
  plan: OrgPlan;
  projectIds: string[];    // ["caroma", "caroma-nz", "dorf"] — refs only
  billing: {
    contactEmail: string;
    country: string;
    currency: string;
    monthlyCap?: number;
    currentPeriodStart?: string;
  };
  settings: {
    ssoEnabled: boolean;
    ssoProvider?: 'okta' | 'azure-ad' | 'google';
    mfaRequired: boolean;
    sessionDurationHours: number;
    allowedDomains: string[];
  };
  createdAt: string;
  updatedAt: string;
}

export interface CreateOrgDto {
  name: string;
  domain: string;
  plan?: OrgPlan;
  billing: Pick<Organization['billing'], 'contactEmail' | 'country' | 'currency'>;
  ownerEmail: string;
  ownerFullName: string;
}
