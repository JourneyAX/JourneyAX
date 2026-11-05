import { z } from 'zod';
const Path = z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/).max(120);
const Id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/).max(64);

/** Routing, field mapping and customer wording belong to the merchant release. */
export const SupportHandoffSchema = z.object({
  connector: Id, tool: Id, subject: z.string().min(3).max(150),
  inputs: z.object({ subject: Id, description: Id, requesterEmail: Id }).strict().refine(value => new Set(Object.values(value)).size === 3, 'Support input mappings must be distinct.'),
  ticketIdPath: Path,
  receiptCard: z.object({ heading: z.string().min(1).max(150), title: z.string().min(1).max(180), detail: z.string().max(500).optional(), badge: z.string().max(80).optional() }).strict().optional(),
}).strict();
