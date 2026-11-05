import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
import type { ToolExecutionContext } from '../src/types';

const env={SAP_S4HANA_API_URL:'https://fixture-api.s4hana.cloud.sap',SAP_S4HANA_USERNAME:'fixture',SAP_S4HANA_PASSWORD:'fixture-secret',SAP_S4HANA_PRODUCT_SERVICE:'/sap/opu/odata/sap/API_PRODUCT_SRV'};
const grant:ToolExecutionContext={actionId:'approved-org-views',tenantId:'fixture',environmentId:'test',principalId:'staff',releaseChecksum:'release'};
const input={productId:'JAX_OWNED',baseUnit:'PC',plant:'1000',availabilityCheckType:'02',profitCenter:'0000001000',mrpType:'ND',mrpController:'001',lotSizingProcedure:'EX',procurementType:'F',loadingGroup:'0001',salesOrganization:'1000',distributionChannel:'10',itemCategoryGroup:'NORM',accountDeterminationGroup:'01',salesUnit:'PC',taxes:[{country:'NZ',category:'MWST',classification:'1'}]};

function fixture({lost=false,failSales=false}={}){
  const rows=new Map<string,any[]>([['A_Product',[{Product:input.productId,BaseUnit:'PC'}]]]);let posts=0,calls=0;
  const fetchImpl=(async(url:any,init:any)=>{
    calls++;const target=new URL(String(url)),entity=target.pathname.split('/').at(-1)!;
    if(entity==='$metadata')return new Response('<edmx:Edmx/>',{headers:{'x-csrf-token':'csrf','set-cookie':'SAP_SESSIONID=fixture; Secure'}});
    if(init.method==='POST'){
      if(failSales&&entity==='A_ProductSalesDelivery'){failSales=false;return Response.json({error:{message:'Source temporarily unavailable'}},{status:503});}
      const body=JSON.parse(init.body);assert.equal(body.Product,input.productId);assert.equal(Object.keys(body).some(key=>/Weight|Volume|Dimension|Price|StockQuantity/.test(key)),false);
      posts++;rows.set(entity,[...(rows.get(entity)||[]),body]);
      if(entity==='A_ProductPlant'&&body.to_ProductSupplyPlanning)rows.set('A_ProductSupplyPlanning',[body.to_ProductSupplyPlanning]);
      if(lost){lost=false;throw new Error('lost after commit');}
      return Response.json({d:body},{status:201});
    }
    const predicates=[...(target.searchParams.get('$filter')||'').matchAll(/(\w+) eq '([^']*)'/g)];
    return Response.json({d:{results:(rows.get(entity)||[]).filter(row=>predicates.every(match=>row[match[1]]===match[2]))}});
  })as typeof fetch;
  const adapter=sapS4hana(env,{fetchImpl,now:Date.now});return{tool:(name:string)=>adapter.tools.find(tool=>tool.name===name)!,rows,stats:()=>({posts,calls})};
}
test('native organisational views reconcile a lost response and replay without duplicate source writes',async()=>{
  const f=fixture({lost:true}),first=await f.tool('extend_product_organisations').run(input,grant),replay=await f.tool('extend_product_organisations').run(input,grant);
  assert.equal(first.sourceReadbackVerified,true);assert.equal(first.reconciledViews,1);assert.equal(first.operationalReadinessAsserted,false);
  assert.equal(replay.createdViews,0);assert.equal(replay.alreadyPresent,5);assert.equal(f.stats().posts,4);
  const read=await f.tool('get_product_organisations').run({productId:input.productId});assert.equal(read.record.salesAreas.records[0].SupplyingPlant,input.plant);
});
test('a partially completed SAP extension resumes only missing exact views',async()=>{
  const f=fixture({failSales:true});await assert.rejects(()=>f.tool('extend_product_organisations').run(input,grant));assert.equal(f.stats().posts,3);
  const replay=await f.tool('extend_product_organisations').run(input,grant);assert.equal(replay.alreadyPresent,4);assert.equal(replay.createdViews,1);assert.equal(f.stats().posts,4);
});
test('existing conflicting or unverified base units block all organisational writes',async()=>{
  const f=fixture();await f.tool('extend_product_organisations').run(input,grant);f.rows.get('A_ProductPlant')![0].MRPType='PD';
  await assert.rejects(()=>f.tool('extend_product_organisations').run(input,grant),/differs from the reviewed/);assert.equal(f.stats().posts,4);
  const other=fixture();await assert.rejects(()=>other.tool('extend_product_organisations').run({...input,baseUnit:'EA'},grant),/approved unit must exist/);assert.equal(other.stats().posts,0);
});
test('approval and explicit organisation/tax mappings are required before touching SAP',async()=>{
  const f=fixture();await assert.rejects(()=>f.tool('extend_product_organisations').run(input),/exact SAP material organisation approval/);
  for(const args of [{...input,plant:''},{...input,salesOrganization:''},{...input,taxes:[]},{...input,loadingGroup:''}])await assert.rejects(()=>f.tool('extend_product_organisations').run(args,grant));
  assert.equal(f.stats().calls,0);
});
test('organisational reads cannot turn an absent material into an echoed source identity',async()=>{
  const f=fixture();f.rows.set('A_Product',[]);
  await assert.rejects(()=>f.tool('get_product_organisations').run({productId:input.productId}),/No unique exact native SAP material exists/);
  assert.equal(f.stats().calls,1);assert.equal(f.stats().posts,0);
});
