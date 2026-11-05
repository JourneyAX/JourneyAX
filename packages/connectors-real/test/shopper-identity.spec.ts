import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { RealConnectorServer } from '../src/server';
import { hashScopeArguments, signScope } from '@journeyax/jax-iq';
import { zendesk } from '../src/connectors/zendesk';

test('signed shopper commands cannot create support requests for a different identity', async () => {
  const secret = 'source-identity-key-with-at-least-32-characters'; let writes = 0;
  const source = new RealConnectorServer({ tenants:['test-tenant'], environmentId:'test', connectionRef:'support', apiKey:'fixture-only', commandScopeSecret:secret,
    connectors:[{ connectorId:'support', title:'Support', description:'Support', required:[], missing:()=>[], tools:[{ name:'create', readOnly:false, shopperIdentityFields:['requesterEmail'], description:'Create', inputSchema:{type:'object',properties:{requesterEmail:{type:'string'}},required:['requesterEmail']}, run:async()=>{ writes++; return {record:{ticketId:42}}; } }] }] });
  for (const [requesterEmail, expected] of [['other@example.test',false],['owner@example.test',true]] as const) {
    const args={requesterEmail}, now=Math.floor(Date.now()/1000);
    const grant:any={v:2,operation:'command',actionId:`action-${expected}`,tenantId:'test-tenant',environmentId:'test',queryId:'q',correlationId:'c',principal:{id:'owner@example.test',audience:'shopper',groups:[]},connectorId:'support',connectionRef:'support',tool:'create',toolState:'allow',toolStateVia:'tool',capRuleIds:[],argsHash:hashScopeArguments(args),fields:[],release:{version:'1',checksum:'fixture'},iat:now,exp:now+60,jti:`nonce-${expected}`};
    let payload:any;
    const request:any={method:'POST',url:'/mcp/support',headers:{authorization:'Bearer fixture-only','x-tenant-id':'test-tenant','x-environment-id':'test','x-principal-id':'owner@example.test','x-connection-ref':'support','x-caller-scope':signScope(grant,secret).header},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'create',arguments:args}}));}};
    await (source as any).onRequest(request,{writeHead:()=>{},end:(body:string)=>{payload=JSON.parse(body);}});
    assert.equal(!payload.error,expected); if(!expected) assert.equal(writes,0);
  }
  assert.equal(writes,1);
  const connector=zendesk({}, { now: Date.now, fetchImpl: async () => { throw new Error('No network in this check.'); } });
  assert.deepEqual(connector.tools.find(tool=>tool.name==='create_ticket')?.shopperIdentityFields,['requesterEmail']);
  assert.deepEqual(connector.tools.find(tool=>tool.name==='get_customer_ticket')?.shopperIdentityFields,['requesterEmail']);
});
