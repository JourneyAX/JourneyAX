import { z } from 'zod';

/** Claim classes the runtime may or may not make about a concept. */
export const ClaimClassSchema = z.enum([
  'catalog_fact',
  'compatibility',
  'requirement',
  'substitution',
  'care_safety',
  'installation_step',
  'safety_instruction',
  'legal_requirement',
  'warranty',
  'suggestion',
]);

export type ClaimClass = z.infer<typeof ClaimClassSchema>;
