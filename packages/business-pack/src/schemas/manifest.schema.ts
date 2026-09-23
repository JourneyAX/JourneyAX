import { z } from 'zod';

export const ManifestSchema = z.object({
  packId: z.string(),
  tenantId: z.string(),
  environmentId: z.enum(['dev', 'test', 'staging', 'production']),
  version: z.string().regex(/^\d+\.\d+\.\d+$/),
  name: z.string(),
  description: z.string().optional(),
  checksum: z.string().optional(),
  publishedAt: z.string().datetime().optional(),
  publishedBy: z.string().optional(),
  previousVersion: z.string().optional(),
  status: z.enum(['draft', 'active', 'archived', 'rolled_back']).default('active'),
  dependencies: z.record(z.string(), z.string()).optional(),
});

export type Manifest = z.infer<typeof ManifestSchema>;
