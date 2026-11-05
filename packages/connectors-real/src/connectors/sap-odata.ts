import { ToolError, type Deps, type Env, type Rec } from '../types';
import { errorFor, redact, send, setting, vendorMessage } from '../http';

const SYSTEM = 'SAP S/4HANA';
const SERVICE = /^(?:\/sap\/opu\/odata\/sap\/[A-Za-z0-9_]+(?:;v=\d{1,4})?|\/sap\/opu\/odata4\/sap\/[A-Za-z0-9_]+\/srvd_a2x\/sap\/[A-Za-z0-9_]+\/\d{4})\/?$/;
const isV4=(service:string)=>service.startsWith('/sap/opu/odata4/');
const ENTITY = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Configuration supplies the API origin/service. Tools supply typed predicates,
 * never arbitrary URLs, OData expressions, navigation paths or next-page links. */
export class SapODataClient {
  constructor(private readonly env: Env, private readonly deps: Deps) {}
  private origin() {
    const value = setting(this.env, 'SAP_S4HANA_API_URL');
    if (!value) throw new ToolError('not_connected', 'SAP API endpoint is not configured.');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new ToolError('not_connected', 'SAP requires an HTTPS API origin without credentials, path or query.');
    return url.origin;
  }
  private async request(method: string, service: string, entity: string, options: { query?: Rec; body?: unknown; headers?: Record<string, string>;keys?:Record<string,string> } = {}) {
    if (!SERVICE.test(service) || entity !== '$metadata' && !ENTITY.test(entity)) throw new ToolError('invalid_arguments', 'Unsupported SAP service or entity.');
    const {keys,...requestOptions}=options;
    if(keys&&(!Object.keys(keys).length||Object.entries(keys).some(([field,value])=>!ENTITY.test(field)||typeof value!=='string'||!value.trim()||value.length>200||/[\x00-\x1f]/.test(value))))throw new ToolError('invalid_arguments','Invalid exact SAP record key.');
    const entityPath=keys?`${entity}(${Object.entries(keys).map(([field,value])=>`${field}='${encodeURIComponent(value.replace(/'/g,"''"))}'`).join(',')})`:entity;
    const username = setting(this.env, 'SAP_S4HANA_USERNAME'), password = setting(this.env, 'SAP_S4HANA_PASSWORD'), token = setting(this.env, 'SAP_S4HANA_ACCESS_TOKEN');
    if (!token && (!username || !password)) throw new ToolError('not_connected', 'SAP API authentication is not configured.');
    const answer = await send(this.deps, SYSTEM, method, `${this.origin()}${service.replace(/\/$/, '')}/${entityPath}`, { ...requestOptions,
      query: { ...(setting(this.env, 'SAP_S4HANA_CLIENT') ? { 'sap-client': setting(this.env, 'SAP_S4HANA_CLIENT') } : {}), ...options.query },
      headers: { authorization: token ? `Bearer ${token}` : `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`, ...options.headers } });
    if (!answer.ok) {
      const error=errorFor(SYSTEM, answer.status, redact(vendorMessage(answer.json, answer.text), [password || '', token || '', username ? Buffer.from(`${username}:${password}`).toString('base64') : '', options.headers?.['x-csrf-token'] || '', options.headers?.cookie || '']));
      Object.assign(error,{httpStatus:answer.status});
      throw error;
    }
    return answer;
  }
  async metadata(service: string): Promise<string> {
    const answer = await this.request('GET', service, '$metadata', { headers: { accept: 'application/xml' } });
    if (!/<(?:\w+:)?Edmx\b/.test(answer.text) || answer.text.length > 4_000_000) throw new ToolError('receipt_unavailable', 'SAP did not return bounded OData metadata.');
    return answer.text;
  }
  async list(service: string, entity: string, options: { predicates?: Array<{ field: string; value: string }>; fields: string[]; limit: number; skip?: number; expand?: string[] }): Promise<{ records: Rec[]; more: boolean }> {
    const invalidExpansion=options.expand&&(options.expand.length>3||options.expand.some(field=>!ENTITY.test(field)||!options.fields.includes(field)));
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 50 || options.skip !== undefined && (!Number.isSafeInteger(options.skip) || options.skip < 0 || options.skip > 10_000) || !options.fields.length || options.fields.some(f => !ENTITY.test(f)) || invalidExpansion) throw new ToolError('invalid_arguments', 'Invalid bounded SAP read.');
    const predicates = options.predicates ?? [];
    if (predicates.some(p => !ENTITY.test(p.field) || typeof p.value !== 'string' || p.value.length > 200 || /[\x00-\x1f]/.test(p.value))) throw new ToolError('invalid_arguments', 'Invalid SAP equality filter.');
    const filter = predicates.map(p => `${p.field} eq '${p.value.replace(/'/g, "''")}'`).join(' and ');
    const answer = await this.request('GET', service, entity, { query: { $format: 'json', $select: [...new Set([...options.fields, ...predicates.map(p => p.field)])].join(','), $top: options.limit, ...(options.skip ? { $skip: options.skip } : {}), ...(options.expand?.length ? { $expand: options.expand.join(',') } : {}), ...(filter ? { $filter: filter } : {}) } });
    const records = isV4(service)?answer.json?.value:answer.json?.d?.results;
    if (!Array.isArray(records) || records.length > options.limit) throw new ToolError('receipt_unavailable', 'SAP did not return the requested bounded record page.');
    if (records.some((row: Rec) => predicates.some(p => row[p.field] !== p.value))) throw new ToolError('scope_mismatch', 'SAP returned a record outside the exact requested source reference; the response was withheld.');
    // Do not follow a vendor-provided next URL. The next request is reconstructed
    // from the same configured origin, entity, equality filters and bounded skip.
    return { records: records.map((row: Rec) => Object.fromEntries(options.fields.filter(field => row[field] !== undefined).map(field => [field, row[field]]))), more: Boolean(isV4(service)?answer.json['@odata.nextLink']:answer.json.d.__next) };
  }
  async create(service: string, entity: string, body: Rec): Promise<Rec> {
    // A fresh CSRF session is tied to this exact API origin/service. It is not a
    // browser cookie, is never returned to the model and is not persisted.
    const session = await this.request('GET', service, '$metadata', { headers: { accept: 'application/xml', 'x-csrf-token': 'Fetch' } });
    const token = session.headers?.['x-csrf-token'];
    const cookie = session.headers?.['set-cookie']?.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map(part => part.split(';')[0].trim()).filter(Boolean).join('; ');
    if (!token || token.toLowerCase() === 'required' || !cookie) throw new ToolError('not_authorised', 'SAP did not establish the required CSRF session; nothing was created.');
    const answer = await this.request('POST', service, entity, { body, headers: { 'x-csrf-token': token, cookie } });
    const row = isV4(service)?answer.json:answer.json?.d;
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new ToolError('receipt_unavailable', 'SAP did not return a created-record receipt. Reconcile before retrying.');
    return row;
  }
  async get(service:string,entity:string,keys:Record<string,string>,fields:string[]):Promise<{record:Rec;etag?:string}>{
    if(!fields.length||fields.some(field=>!ENTITY.test(field)))throw new ToolError('invalid_arguments','Invalid exact SAP record fields.');
    const answer=await this.request('GET',service,entity,{keys,query:{$format:'json',$select:[...new Set([...Object.keys(keys),...fields])].join(',')}});
    const row=isV4(service)?answer.json:answer.json?.d;
    if(!row||Array.isArray(row)||Object.entries(keys).some(([field,value])=>row[field]!==value))throw new ToolError('scope_mismatch','SAP did not return the exact requested source record.');
    return{record:Object.fromEntries(fields.filter(field=>row[field]!==undefined).map(field=>[field,row[field]])),etag:answer.headers?.etag||row.__metadata?.etag||row['@odata.etag']};
  }
  /** Only exact ETag-protected source updates are allowed. No wildcard match. */
  async patch(service:string,entity:string,keys:Record<string,string>,expected:Rec,changes:Rec):Promise<void>{
    if(!Object.keys(changes).length||Object.keys(changes).some(field=>!ENTITY.test(field))||Object.keys(expected).some(field=>!ENTITY.test(field)))throw new ToolError('invalid_arguments','Invalid explicit SAP update fields.');
    const current=await this.get(service,entity,keys,[...new Set([...Object.keys(expected),...Object.keys(changes)])]);
    if(!Object.entries(expected).every(([field,value])=>current.record[field]===value))throw new ToolError('conflict','SAP fields changed before the approved update.');
    if(!current.etag||current.etag==='*')throw new ToolError('conflict','SAP did not expose a source ETag for this update; no unconditional overwrite was attempted.');
    const session=await this.request('GET',service,'$metadata',{headers:{accept:'application/xml','x-csrf-token':'Fetch'}});
    const token=session.headers?.['x-csrf-token'],cookie=session.headers?.['set-cookie']?.split(/,(?=\s*[^;,=\s]+=[^;,]*)/).map(part=>part.split(';')[0].trim()).filter(Boolean).join('; ');
    if(!token||token.toLowerCase()==='required'||!cookie)throw new ToolError('not_authorised','SAP did not establish a CSRF session; no update was attempted.');
    await this.request('PATCH',service,entity,{keys,body:changes,headers:{'x-csrf-token':token,cookie,'if-match':current.etag}});
  }
}

/** Technical service paths come from the tenant's API arrangement, never a UI URL. */
export const sapService = (env: Env, name: string): string => {
  const value = setting(env, `SAP_S4HANA_${name}_SERVICE`);
  if (!value || !SERVICE.test(value)) throw new ToolError('not_connected', `The SAP ${name.toLowerCase()} API arrangement has not been configured.`);
  return value;
};
