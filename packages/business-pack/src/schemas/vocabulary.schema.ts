import { z } from 'zod';

export const VocabularyTermSchema = z.object({
  term: z.string(),
  canonical: z.string(),
  category: z.string().optional(),
  synonyms: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export const VocabularySchema = z.object({
  version: z.string().default('1.0.0'),
  terms: z.array(VocabularyTermSchema).default([]),
  acronyms: z.record(z.string(), z.string()).default({}),
  slotSynonyms: z.record(z.string(), z.array(z.string())).default({}),
  prohibitedTerms: z.array(z.string()).default([]),
});

export type Vocabulary = z.infer<typeof VocabularySchema>;
