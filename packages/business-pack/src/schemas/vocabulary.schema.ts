import { z } from 'zod';

export const VocabularyTermSchema = z.object({
  term: z.string(),
  canonical: z.string(),
  category: z.string().optional(),
  synonyms: z.array(z.string()).default([]),
  description: z.string().optional(),
});

export const SlotMappingSchema = z.object({
  cardinality: z.enum(['one', 'many']).default('one'),
  values: z.array(z.object({
    value: z.union([z.string(), z.number(), z.boolean()]),
    phrases: z.array(z.string()).min(1),
  })).default([]),
});

export const VocabularySchema = z.object({
  version: z.string().default('1.0.0'),
  terms: z.array(VocabularyTermSchema).default([]),
  acronyms: z.record(z.string(), z.string()).default({}),
  slotSynonyms: z.record(z.string(), z.array(z.string())).default({}),
  /** Canonical, domain-defined fact extraction mappings. */
  slotMappings: z.record(z.string(), SlotMappingSchema).default({}),
  prohibitedTerms: z.array(z.string()).default([]),
});

export type Vocabulary = z.infer<typeof VocabularySchema>;
