import { ConnectorsSchema, connectorToolState, type ConnectorsExtension } from '@journeyax/business-pack';
import { ClaimClassSchema } from '@journeyax/knowledge';
import { DictionaryPartSchema, JaxOntologyReleaseSchema, checkDictionary, mergeDictionaryParts, type DictionaryPart, type JaxOntologyRelease } from '@journeyax/jax-iq';

export interface IqIdentityGuard { thing: string; system: string; tool: string; keyKind: string; select: string }

/** Pure authoring preparation. This never publishes, grants writes or changes source records. */
export function buildIqIdentityCandidate(input: { ontology: unknown; connectors: unknown; customerPart: unknown; guards: IqIdentityGuard[] }): { jaxOntology: JaxOntologyRelease; connectors: ConnectorsExtension; changedBindings: string[] } {
  const original = JaxOntologyReleaseSchema.parse(input.ontology) as JaxOntologyRelease;
  const connectors = ConnectorsSchema.parse(structuredClone(input.connectors));
  const part = DictionaryPartSchema.parse(input.customerPart) as DictionaryPart;
  if (part.replaces?.length) throw new Error('Identity additions cannot replace existing business concepts.');
  const { schemaVersion: _schema, ontologyId, enabled, selfConnector, claimGuard, notes, customerAccess, customerIdentity, retailCustomerIdentity, ...existingPart } = original;
  const stable = (value: unknown): string => JSON.stringify(value, function (_key, item) { return item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item; });
  const identities = { things: 'thing', facts: 'fact', links: 'link', bindings: 'bindingId', permissionRules: 'ruleId', signalRules: 'signalId', settings: 'key', stateMaps: 'id' } as const;
  // Re-running a reviewed draft preparation is safe only for identical entities. Changed definitions require explicit review.
  for (const [field, id] of Object.entries(identities)) {
    const additions = (part as any)[field] ?? [];
    (existingPart as any)[field] = ((existingPart as any)[field] ?? []).filter((entry: any) => {
      const addition = additions.find((value: any) => value[id] === entry[id]);
      if (!addition) return true;
      if (stable(addition) !== stable(entry)) throw new Error(`Identity additions conflict with existing ${field} definition.`);
      return false;
    });
  }
  const merged = mergeDictionaryParts([{ partId: 'existing-active-dictionary', ...existingPart }, part], { ontologyId, enabled, selfConnector, claimGuard, notes });
  if (!merged.block || merged.issues.some(issue => issue.severity === 'error')) throw new Error('Identity additions conflict with the existing dictionary.');
  const ontology = JaxOntologyReleaseSchema.parse({ ...merged.block, ...(customerAccess ? { customerAccess } : {}), ...(customerIdentity ? { customerIdentity } : {}), ...(retailCustomerIdentity ? { retailCustomerIdentity } : {}) }) as JaxOntologyRelease;
  const changedBindings: string[] = [];
  for (const guard of input.guards) {
    const bindings = ontology.bindings.filter(binding => binding.system === guard.system && binding.tool === guard.tool && (binding.target.kind === 'fact' ? binding.target.fact : binding.target.link).startsWith(`${guard.thing}.`));
    if (!bindings.length) throw new Error(`No declared bindings match identity guard ${guard.system}.${guard.tool}.`);
    for (const binding of bindings) {
      binding.identity = { keyKind: guard.keyKind, select: guard.select };
      changedBindings.push(binding.bindingId);
    }
  }
  // These are narrow, new read tools. Do not reuse broad connector defaults or change any older source policy.
  const reads = new Map<string, { system: string; tool: string; groups: string[] }>();
  for (const binding of part.bindings ?? []) {
    const thing = binding.target.kind === 'fact' ? binding.target.fact.split('.')[0] : binding.target.link.split('.')[0];
    const rules = (part.permissionRules ?? []).filter(rule => rule.mode === 'see' && rule.target.thing === thing);
    const groups = [...new Set(rules.flatMap(rule => rule.who.flatMap(who => who.groups)))].sort();
    if (!groups.length) throw new Error('Identity source reads require explicitly named staff groups.');
    reads.set(`${binding.system}.${binding.tool}`, { system: binding.system, tool: binding.tool, groups });
  }
  for (const read of reads.values()) {
    const connector = connectors.connectors.find(source => source.connectorId === read.system);
    if (!connector || !connector.enabled || connector.sample || !connector.connectionRef) throw new Error('A configured real identity source is required.');
    const prior = connector.tools.find(tool => tool.name === read.tool);
    if (prior && prior.sideEffect !== 'read') throw new Error('Identity lookup cannot grant a source write.');
    if (!prior) connector.tools.push({ name: read.tool, sideEffect: 'read', summary: 'Read only exact registered customer source IDs and canonical reference; no email or address.' });
    connectors.policy = connectors.policy.filter(row => !(row.connectorId === read.system && row.tool === read.tool));
    connectors.policy.push({ connectorId: read.system, tool: read.tool, audience: 'staff', groups: read.groups, state: 'allow' });
    const principals = [{ audience: 'shopper' as const, groups: [] }, { audience: 'staff' as const, groups: [] }, ...[...new Set(connectors.policy.flatMap(row => row.groups))].filter(group => !read.groups.includes(group)).map(group => ({ audience: 'staff' as const, groups: [group] }))];
    if (principals.some(principal => connectorToolState(connectors, read.system, read.tool, principal).state !== 'blocked')) throw new Error('A broad source default would expose the new identity lookup outside its staff groups.');
    for (const group of read.groups) if (connectorToolState(connectors, read.system, read.tool, { audience: 'staff', groups: [group] }).state !== 'allow') throw new Error('An existing policy blocks the scoped identity reader.');
  }
  const problems = checkDictionary(ontology, { connectors, knownClaimClasses: ClaimClassSchema.options }).filter(issue => issue.severity === 'error');
  if (problems.length) throw new Error(problems.map(issue => `${issue.path}: ${issue.message}`).join('\n'));
  return { jaxOntology: ontology, connectors: ConnectorsSchema.parse(connectors), changedBindings: changedBindings.sort() };
}
