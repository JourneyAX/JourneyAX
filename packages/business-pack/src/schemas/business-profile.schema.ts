import { z } from 'zod';

export const BusinessProfileSchema = z.object({
  companyName: z.string(),
  industry: z.string(),
  brandTone: z.string().optional(),
  mission: z.string().optional(),
  primaryCurrency: z.string().default('AUD'),
  supportedCurrencies: z.array(z.string()).default(['AUD']),
  primaryLocale: z.string().default('en-AU'),
  supportedLocales: z.array(z.string()).default(['en-AU']),
  headquarters: z.string().optional(),
  complianceCertifications: z.array(z.string()).optional(),
  contactEmail: z.string().email().optional(),
});

export type BusinessProfile = z.infer<typeof BusinessProfileSchema>;
