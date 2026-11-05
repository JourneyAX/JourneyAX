import { JaxOntologyReleaseSchema, type IqContext } from '@journeyax/jax-iq';

export interface RetailIqIdentityPort {
  forPrincipal(scope: { tenantId: string; environmentId: string; principalId: string }, release: unknown): Promise<IqContext['principal']['subjects']>;
}

/** Runtime auth metadata only. Business facts still come through IQ/source tools. No name/email matching across vendors. */
export class MongoRetailIqIdentityPort implements RetailIqIdentityPort {
  constructor(private readonly getRuntimeDb: () => any | Promise<any>) {}
  async forPrincipal(scope: { tenantId: string; environmentId: string; principalId: string }, release: any): Promise<IqContext['principal']['subjects']> {
    const parsed = JaxOntologyReleaseSchema.safeParse(release?.extensions?.jaxOntology);
    const mapping = parsed.success && parsed.data.retailCustomerIdentity;
    if (!mapping || !scope.principalId || ['anonymous', 'customer', 'guest@anonymous'].includes(scope.principalId) || release?.manifest?.tenantId !== scope.tenantId || release?.manifest?.environmentId !== scope.environmentId) return [];
    const thing = parsed.data.things.find(value => value.thing === mapping.thing);
    if (!thing || !(parsed.data.customerAccess ?? []).some(value => value.thing === mapping.thing && value.roles?.includes(mapping.role))) return [];
    try {
      const db = await this.getRuntimeDb();
      const rows = await db.collection('customer_profile_links').find({ ...scope, status: 'ready' }, { projection: { _id: 0, tenantId: 1, environmentId: 1, principalId: 1, canonicalId: 1, status: 1 }, maxTimeMS: 3000 }).limit(2).toArray();
      if (rows.length !== 1) return [];
      const row = rows[0];
      if (row.tenantId !== scope.tenantId || row.environmentId !== scope.environmentId || row.principalId !== scope.principalId || row.status !== 'ready' || typeof row.canonicalId !== 'string' || row.canonicalId.length > 200 || !new RegExp(thing.key.pattern).test(row.canonicalId)) return [];
      return [{ thing: mapping.thing, canonicalId: row.canonicalId, role: mapping.role }];
    } catch { return []; }
  }
}
