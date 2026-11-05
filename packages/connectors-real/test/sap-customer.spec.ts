import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
import type { ToolExecutionContext } from '../src/types';

const env={SAP_S4HANA_API_URL:'https://fixture-api.s4hana.cloud.sap',SAP_S4HANA_USERNAME:'fixture',SAP_S4HANA_PASSWORD:'fixture-secret',SAP_S4HANA_CUSTOMER_SERVICE:'/sap/opu/odata/sap/API_BUSINESS_PARTNER'};
const grant:ToolExecutionContext={actionId:'approved-customer',tenantId:'fixture',environmentId:'test',principalId:'staff',releaseChecksum:'release'};
const input={customerReference:'JAXABC123',category:'1',grouping:'BP01',correspondenceLanguage:'EN',customerAccountGroup:'AG01',customerRole:'FLCU01',firstName:'Owned',lastName:'Customer',country:'NZ',city:'Auckland',salesArea:{salesOrganization:'1000',distributionChannel:'10',division:'00',currency:'NZD',paymentTerms:'0001',accountAssignmentGroup:'01',shippingCondition:'01'}};

function fixture({lost=false,denied=false}={}){
  let partner:any,creates=0,calls=0;
  const fetchImpl=(async(url:any,init:any)=>{
    calls++;const target=new URL(String(url)),entity=target.pathname.split('/').at(-1);
    if(denied)return Response.json({error:{message:'Source scenario is unavailable'}},{status:403});
    if(entity==='$metadata')return new Response('<edmx:Edmx/>',{headers:{'x-csrf-token':'csrf','set-cookie':'SAP_SESSIONID=fixture; Secure'}});
    if(init.method==='POST'){
      assert.equal(entity,'A_BusinessPartner');const body=JSON.parse(init.body);creates++;
      partner={...body,BusinessPartner:'BP123',to_Customer:{...body.to_Customer,Customer:'CUSTOMER99'}};
      if(lost){lost=false;throw new Error('lost after commit');}
      return Response.json({d:partner},{status:201});
    }
    let rows:any[]=[];
    if(partner){
      if(entity==='A_BusinessPartner')rows=[partner];
      if(entity==='A_BusinessPartnerRole')rows=partner.to_BusinessPartnerRole.results.map((row:any)=>({...row,BusinessPartner:partner.BusinessPartner}));
      if(entity==='A_CustomerSalesArea')rows=partner.to_Customer.to_CustomerSalesArea.results.map((row:any)=>({...row,Customer:partner.to_Customer.Customer}));
      if(entity==='A_BusinessPartnerAddress')rows=partner.to_BusinessPartnerAddress.results.map((row:any)=>({...row,BusinessPartner:partner.BusinessPartner}));
    }
    return Response.json({d:{results:rows}});
  })as typeof fetch;
  const adapter=sapS4hana(env,{fetchImpl,now:Date.now});
  return{tool:(name:string)=>adapter.tools.find(tool=>tool.name===name)!,stats:()=>({calls,creates}),get partner(){return partner;}};
}

test('customer creation reconciles lost responses by owned reference and keeps native BP/customer IDs distinct',async()=>{
  const f=fixture({lost:true}),first=await f.tool('create_customer').run(input,grant),replay=await f.tool('create_customer').run(input,grant);
  assert.equal(first.created,true);assert.equal(first.reconciled,true);assert.equal(first.record.businessPartnerId,'BP123');assert.equal(first.record.customerId,'CUSTOMER99');
  assert.equal(replay.created,false);assert.equal(f.stats().creates,1);
  const read=await f.tool('get_customer').run({customerReference:input.customerReference});assert.equal(read.record.customerId,'CUSTOMER99');
  f.partner.to_Customer.to_CustomerSalesArea.results[0].Currency='USD';
  await assert.rejects(()=>f.tool('create_customer').run(input,grant),/exact reviewed customer role, address and sales-area/);assert.equal(f.stats().creates,1);
});
test('customer identity changes or look-alike references cannot overwrite or select an existing source customer',async()=>{
  const f=fixture();await f.tool('create_customer').run(input,grant);
  await assert.rejects(()=>f.tool('create_customer').run({...input,lastName:'Different'},grant),/different approved identity/);
  await assert.rejects(()=>f.tool('get_customer').run({customerReference:'JAXOTHER'}),/outside the exact requested source reference/);assert.equal(f.stats().creates,1);
});
test('unavailable customer scope cannot create, fall back or invent a sold-to',async()=>{
  const f=fixture({denied:true});await assert.rejects(()=>f.tool('create_customer').run(input,grant),(error:any)=>error.code==='not_authorised'&&error.httpStatus===403);assert.equal(f.stats().creates,0);
});
test('customer approval and reviewed organisation/address settings are required before source access',async()=>{
  const f=fixture();await assert.rejects(()=>f.tool('create_customer').run(input),/verified exact SAP customer-master approval/);
  for(const args of [{...input,customerReference:'arbitrary-name'},{...input,salesArea:null},{...input,grouping:''},{...input,country:''},{...input,correspondenceLanguage:''}])await assert.rejects(()=>f.tool('create_customer').run(args,grant));
  assert.equal(f.stats().calls,0);
});
