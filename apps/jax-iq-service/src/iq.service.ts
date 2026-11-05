import { randomUUID } from 'node:crypto';
import { ClaimClassSchema } from '@journeyax/knowledge';
import { Injectable } from '@nestjs/common';
import { MongoClient, type Db } from 'mongodb';
import { PackRepository, getVerifiedBusinessPackMetadata, ConnectorsSchema, mcpServerNameOf } from '@journeyax/business-pack';
import { EnvMcpServerDirectory, McpClientPool } from '@journeyax/capability-sdk';
import { signScope, hashScopeArguments, IqQueryEngine, JaxOntologyReleaseSchema, checkDictionary, type IqContext, type IqResponse, type IqReadPort, checkKeyRow, type KeyRow, type ReleaseSource, type KeyScope, type LoadedRelease, type ReleaseFailure, type JaxOntologyRelease } from '@journeyax/jax-iq';

export const IQ_KEY_COLLECTION = 'jax_iq_keys';
export const IQ_NONCE_COLLECTION = 'jax_iq_query_nonces';

/** Connections are lazy. Constructing the application cannot seed, publish, index or connect to a remote cluster. */
export class IqMongoStore {
  private client?: MongoClient;
  private connection?: Promise<Db>;
  async db(): Promise<Db> {
    if (!this.connection) {
      const uri = process.env.JAX_IQ_MONGODB_URI;
      const database = process.env.JAX_IQ_MONGODB_DB;
      if (!uri || !database) throw new Error('IQ storage is not configured.');
      this.client = new MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });
      this.connection = this.client.connect().then(client => client.db(database)).catch(error => { this.connection = undefined; throw error; });
    }
    return this.connection;
  }
  async claim(jti: string, context: IqContext, expiresAt: Date): Promise<boolean> {
    const db = await this.db();
    // _id is intrinsically unique; replay protection does not depend on a deployment script having created an index.
    try { await db.collection(IQ_NONCE_COLLECTION).insertOne({ _id: `${context.tenantId}:${context.environmentId}:${jti}` as any, expiresAt }); return true; }
    catch (error: any) { if (error?.code === 11000) return false; throw error; }
  }
  async close(): Promise<void> { await this.client?.close(); }
}

/** Runtime only reads identity rows. Provisioning verified identity links is a separate, auditable operation. */
export class MongoIqKeys {
  constructor(private readonly store: Pick<IqMongoStore, 'db'>) {}
  async findBySystemKey(scope: KeyScope, system: string, keyKind: string, systemKey: string): Promise<KeyRow | undefined> {
    const rows = await (await this.store.db()).collection<KeyRow>(IQ_KEY_COLLECTION).find({ ...scope, system, keyKind, systemKey }, { projection: { _id: 0 }, maxTimeMS: 5_000 }).limit(2).toArray();
    if (rows.length > 1 || rows.some(row => checkKeyRow(row).length > 0)) throw new Error('The identity link is ambiguous or invalid.');
    return rows[0];
  }

  async findByCanonicalId(scope: KeyScope, canonicalId: string): Promise<KeyRow[]> {
    const rows = await (await this.store.db()).collection(IQ_KEY_COLLECTION).find({ ...scope, canonicalId }, { projection: { _id: 0 }, maxTimeMS: 5_000 }).limit(201).toArray() as unknown as KeyRow[];
    const primaries = rows.filter(row => row.role === 'primary' && row.status === 'matched').map(row => JSON.stringify([row.system, row.keyKind]));
    if (rows.length > 200 || rows.some(row => checkKeyRow(row).length > 0) || new Set(primaries).size !== primaries.length) throw new Error('The identity links are ambiguous or invalid.');
    return rows;
  }
}

export class MongoIqReleases implements ReleaseSource {
  private repository?: PackRepository;
  constructor(private readonly store: Pick<IqMongoStore, 'db'>) {}
  async load(tenantId: string, environmentId: IqContext['environmentId'], pin?: IqContext['release']): Promise<LoadedRelease | ReleaseFailure> {
    try {
      this.repository ??= new PackRepository(await this.store.db());
      const pack = pin ? await this.repository.loadPinnedPack(tenantId, environmentId, pin.version, pin.checksum) : await this.repository.loadActivePack(tenantId, environmentId);
      const meta = getVerifiedBusinessPackMetadata(pack);
      if (!meta || meta.tenantId !== tenantId || meta.environmentId !== environmentId) throw new Error('Release scope mismatch.');
      const ontology = JaxOntologyReleaseSchema.parse(pack.extensions?.jaxOntology) as JaxOntologyRelease;
      const connectors = ConnectorsSchema.parse(pack.extensions?.connectors);
      if (!ontology.enabled || checkDictionary(ontology, { connectors, knownClaimClasses: ClaimClassSchema.options }).some(issue => issue.severity === 'error')) throw new Error('Dictionary is not ready.');
      return { version: meta.version, checksum: meta.checksum, ontology, connectors };
    } catch {
      return { ok: false as const, code: 'release_unavailable' as const, reason: 'ontology_invalid' as const, message: 'The pinned business dictionary is not available.' };
    }
  }
}

/** Uses the existing MCP client, server directory and scoped secret references. No vendor-specific reads live in the query engine. */
export class McpIqReader implements IqReadPort {
  constructor(private readonly pool = new McpClientPool({ directory: new EnvMcpServerDirectory() })) {}
  async read(call: Parameters<IqReadPort['read']>[0], release: Parameters<IqReadPort['read']>[1]) {
    const connector = release.connectors.connectors.find(entry => entry.connectorId === call.system && entry.enabled !== false);
    if (!connector || connector.tools.find(entry => entry.name === call.tool)?.sideEffect !== 'read') return { ok: false as const, kind: 'not_read_only' as const, message: 'Read not allowed.' };
    try {
      const secret = process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET;
      if (!secret || secret.length < 32 || !connector.connectionRef) return { ok: false as const, kind: 'not_configured' as const, message: 'A scoped connector connection is required.' };
      const iat = Math.floor(Date.now() / 1000);
      const callerScope = signScope({ v: 2, tenantId: call.context.tenantId, environmentId: call.context.environmentId,
        queryId: call.context.queryId, correlationId: call.context.correlationId,
        principal: { id: call.context.principal.id, audience: call.context.principal.audience, groups: call.context.principal.groups },
        connectorId: call.system, connectionRef: connector.connectionRef, tool: call.tool,
        toolState: 'allow', toolStateVia: 'tool', capRuleIds: [], argsHash: hashScopeArguments(call.args), fields: [...new Set(call.fields)],
        release: call.context.release, iat, exp: iat + 60, jti: randomUUID(),
      }, secret).header;
      const client = await this.pool.getClient(mcpServerNameOf(connector), { tenantId: call.context.tenantId, environmentId: call.context.environmentId, connectionRef: connector.connectionRef, secretRef: connector.secretRef });
      const output = await client.callTool(call.tool, call.args, { tenantId: call.context.tenantId, environmentId: call.context.environmentId, correlationId: call.context.correlationId, principalId: call.context.principal.id, connectionRef: connector.connectionRef, callerScope }, { signal: call.signal });
      if (output.isError) return { ok: false as const, kind: 'tool_error' as const, message: output.text };
      let data = output.data;
      if (data === undefined) { try { data = JSON.parse(output.text); } catch { return { ok: false as const, kind: 'protocol' as const, message: 'Source did not return structured records.' }; } }
      // Real connectors wrap success as {ok, data}; the wrapper is transport, not a vendor field path.
      if ((data as any)?.ok === false) return { ok: false as const, kind: 'tool_error' as const, message: 'Source refused the query.' };
      return { ok: true as const, data, truncated: output.truncated, incomplete: (data as any)?.more === true || (data as any)?.record?.more === true, bytes: output.bytes };
    } catch { return { ok: false as const, kind: call.signal.aborted ? 'timeout' as const : 'transport' as const, message: 'Connector unavailable.' }; }
  }
  async close() { await this.pool.closeAll(); }
}

@Injectable()
export class IqService {
  readonly store = new IqMongoStore();
  readonly reader = new McpIqReader();
  readonly engine = new IqQueryEngine({ releases: new MongoIqReleases(this.store), keys: new MongoIqKeys(this.store), reader: this.reader });
  query(body: unknown, context: IqContext, signal?: AbortSignal): Promise<IqResponse> { return this.engine.query(body, context, signal); }
  async onModuleDestroy() { await this.reader.close(); await this.store.close(); }
}
