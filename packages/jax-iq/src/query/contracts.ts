import { z } from 'zod';
import type { Environment } from '../model';
import type { MergedFact } from '../merge';

const Id = z.string().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
const Name = z.string().min(1).max(81).regex(/^[A-Za-z][A-Za-z0-9_.]*$/);
const Subject = z.union([
  z.object({ thing: Name, canonicalId: Id }).strict(),
  z.object({ thing: Name, key: z.object({ kind: Name, value: Id }).strict() }).strict(),
]);
const Fields = z.array(Name).max(100).optional();
const Filters = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.union([z.string().max(1000).regex(/^[^\u0000-\u001f\u007f]*$/), z.number().finite(), z.boolean()])).refine(value => Object.keys(value).length <= 20).optional();

/** No tenant, principal, scope, raw query language, tool name or connector address is accepted from a chat tool. */
export const IqQuerySchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('find'), thing: Name, query: z.string().trim().min(1).max(200) }).strict(),
  z.object({ operation: z.literal('get'), subject: Subject, facts: Fields, filters: Filters }).strict(),
  z.object({ operation: z.literal('related'), subject: Subject, link: Name, facts: Fields, filters: Filters }).strict(),
  z.object({ operation: z.literal('explain'), subject: Subject, facts: Fields }).strict(),
]);
export type IqQuery = z.infer<typeof IqQuerySchema>;

/** Transport verifies this envelope; the public request schema cannot supply or replace it. */
export interface IqContext {
  tenantId: string;
  environmentId: Environment;
  queryId: string;
  correlationId: string;
  disabledConnectors?: string[];
  release: { version: string; checksum: string };
  principal: {
    id: string;
    audience: 'staff' | 'shopper';
    groups: string[];
    /** Authenticated company/account links only, resolved by the harness's company directory. */
    subjects: Array<{ thing: string; canonicalId: string; role?: string }>;
    identities?: Array<{ thing: string; keyKind: string; value: string; role?: string }>;
  };
}

export interface IqRecord {
  subject: { thing: string; canonicalId: string };
  facts: MergedFact[];
}
export interface IqPage { bindingId: string; subject: IqRecord['subject']; cursorParam: string; more: boolean; nextCursor?: string }
export type IqResponse =
  | { ok: false; code: string; queryId: string }
  | { ok: true; queryId: string; release: IqContext['release']; status: 'complete' | 'partial' | 'ambiguous' | 'no_match'; records: IqRecord[]; candidates?: unknown[]; pages?: IqPage[]; sources: Array<{ system: string; sample: boolean; truncated: boolean }>; untrustedText: true };
