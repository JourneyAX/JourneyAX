import { z } from 'zod';
const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const Path = z.string().regex(/^[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*$/).max(120);
/** Source customer records are explicitly mapped; the runtime never guesses which CRM or commerce connector owns them. */
export const CustomerProfilesSchema = z.object({ enabled: z.boolean(), sources: z.array(z.object({ connectorId: Id, createTool: Id, readTool: Id, orderReadTool: Id.optional(), orderLinkTool: Id.optional(), references: z.record(Id, Path).refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 8) }).strict().refine(s => Boolean(s.orderReadTool) === Boolean(s.orderLinkTool), 'Order linkage requires both read and write tools.')).min(1).max(8) }).strict();
