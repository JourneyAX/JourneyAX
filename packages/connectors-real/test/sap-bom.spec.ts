import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
const env={SAP_S4HANA_API_URL:'https://fixture-api.s4hana.cloud.sap',SAP_S4HANA_USERNAME:'fixture-user',SAP_S4HANA_PASSWORD:'fixture-password',SAP_S4HANA_BOM_SERVICE:'/sap/opu/odata/sap/API_BILL_OF_MATERIAL_SRV;v=2'};
const args={productId:'PARENT',plant:'1000',usage:'1',alternative:'01',status:'01',baseUnit:'EA',baseQuantity:'1.000',validFrom:'2026-11-03',description:'Reviewed assembly',components:[{itemNumber:'0010',productId:'COMPONENT',quantity:'2.000',unit:'EA',category:'L'}]};
const scope={actionId:'approved-bom',tenantId:'fixture',environmentId:'test',principalId:'staff',releaseChecksum:'verified-release'};
function fixture(denied=false){
 let header:any,creates=0,lost=true;
 const tool=sapS4hana(env,{now:Date.now,fetchImpl:(async(url:any,init:any)=>{
  const entity=new URL(String(url)).pathname.split('/').at(-1);
  if(denied)return Response.json({error:{message:'API scope unavailable'}},{status:403});
  if(entity==='$metadata')return new Response('<edmx:Edmx/>',{headers:{'x-csrf-token':'fixture-csrf','set-cookie':'SAP_SESSIONID=fixture-session; Secure'}});
  if(init.method==='POST'){creates++;header={...JSON.parse(String(init.body)),BillOfMaterial:'00001234'};if(lost){lost=false;throw new Error('response lost after create');}return Response.json({d:header},{status:201});}
  const records=entity==='MaterialBOM'?(header?[header]:[]):header?header.to_BillOfMaterialItem.map((row:any)=>({...row,BillOfMaterial:header.BillOfMaterial,Material:header.Material,Plant:header.Plant})):[];
  return Response.json({d:{results:records}});
 })as typeof fetch}).tools.find(tool=>tool.name==='create_bill_of_material')!;
 return{tool,get header(){return header;},get creates(){return creates;}};
}
test('native material BOM header and every reviewed component are reconciled after a lost response',async()=>{
 const f=fixture(),result=await f.tool.run(args,scope);assert.equal(result.created,true);assert.equal(result.reconciled,true);assert.equal(result.record.billOfMaterialId,'00001234');
 const again=await f.tool.run(args,scope);assert.equal(again.created,false);assert.equal(f.creates,1);
 assert.equal(f.header.HeaderValidityStartDate,`/Date(${Date.parse(args.validFrom)})/`);
 f.header.to_BillOfMaterialItem[0].BillOfMaterialItemQuantity='3.000';await assert.rejects(()=>f.tool.run(args,scope),/different source components/);assert.equal(f.creates,1);
});
test('unavailable SAP BOM permission cannot fall through to a create or demo assembly',async()=>{
 const f=fixture(true);await assert.rejects(()=>f.tool.run(args,scope),/does not allow/);assert.equal(f.creates,0);
});
test('BOM approval, real date and explicit plant/component units are required',async()=>{
 const f=fixture();await assert.rejects(()=>f.tool.run(args),/verified SAP BOM approval/);
 await assert.rejects(()=>f.tool.run({...args,validFrom:'2026-02-30'},scope),/calendar date/);
 await assert.rejects(()=>f.tool.run({...args,plant:''},scope),/SAP plant/);
 await assert.rejects(()=>f.tool.run({...args,components:[{...args.components[0],unit:''}]},scope),/component unit/);assert.equal(f.creates,0);
});
