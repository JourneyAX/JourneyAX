import { z } from 'zod';

export const EntityAttributeSchema = z.object({
  name: z.string(),
  type: z.enum(['string', 'number', 'boolean', 'array', 'object', 'date', 'currency']),
  required: z.boolean().default(false),
  description: z.string().optional(),
  enum: z.array(z.string()).optional(),
  unit: z.string().optional(),
});

export const EntityDefinitionSchema = z.object({
  entityId: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  attributes: z.array(EntityAttributeSchema).default([]),
  primaryKey: z.string().default('id'),
  searchableAttributes: z.array(z.string()).default([]),
});

export const EntitiesSchema = z.object({
  version: z.string().default('1.0.0'),
  entities: z.array(EntityDefinitionSchema).default([]),
});

export type Entities = z.infer<typeof EntitiesSchema>;
