import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
import type { ToolExecutionContext } from '../src/types';
const env={SAP_S4HANA_API_URL:'https://fixture-api.s4hana.cloud.sap',SAP_S4HANA_USERNAME:'fixture-user',SAP_S4HANA_PASSWORD:'fixture-secret',SAP_S4HANA_PRODUCT_SERVICE:'/sap/opu/odata/sap/API_PRODUCT_SRV',SAP_S4HANA_ORDER_SERVICE:'/sap/opu/odata/sap/API_SALES_ORDER_SRV'};
const grant:ToolExecutionContext={actionId:'exact-approved-action',tenantId:'fixture',environmentId:'test',principalId:'staff',releaseChecksum:'verified-release'};
function fixture(lostResponse=false,nativeNet='10.00'){
  let product:any,order:any,productCreates=0,orderCreates=0,calls=0;
  const deps={now:Date.now,fetchImpl:(async(url:any,init:any)=>{
    calls++;const target=new URL(String(url)),entity=target.pathname.split('/').at(-1),body=init.body?JSON.parse(String(init.body)):undefined;
    if(entity==='$metadata')return new Response('<edmx:Edmx/>',{headers:{'x-csrf-token':'fixture-csrf','set-cookie':'SAP_SESSIONID=fixture-cookie; Secure'}});
    if(init.method==='POST'){
      assert.equal(new Headers(init.headers).get('x-csrf-token'),'fixture-csrf');
      if(entity==='A_Product'){assert.ok(Array.isArray(body.to_Description?.results));assert.equal(body.to_Description.results[0].Product,body.Product,'native deep children carry the exact parent material key');productCreates++;product=body;}else{assert.equal(entity,'A_SalesOrder');orderCreates++;order={...body,SalesOrder:'45000001',TotalNetAmount:nativeNet,OverallSDProcessStatus:'A'};}
      if(lostResponse){lostResponse=false;throw new Error('lost after commit');}
      return Response.json({d:entity==='A_Product'?product:order},{status:201});
    }
    let records:any[]=[];
    if(entity==='A_Product'&&product)records=[product];
    if(entity==='A_ProductDescription'&&product)records=product.to_Description.results;
    if(entity==='A_SalesOrder'&&order)records=[order];
    if(entity==='A_SalesOrderItem'&&order)records=order.to_Item.map((row:any)=>({...row,SalesOrder:order.SalesOrder}));
    return Response.json({d:{results:records}});
  })as typeof fetch};
  const adapter=sapS4hana(env,deps);return{tool:(name:string)=>adapter.tools.find(t=>t.name===name)!,stats:()=>({productCreates,orderCreates,calls}),get product(){return product;},get order(){return order;}};
}
const product={productId:'SOURCE-42',productType:'TYPE',industrySector:'M',baseUnit:'EA',description:'Source description',language:'EN'};
const order={customerReference:'owned-reference',customerId:'100010',orderType:'TYPE',salesOrganization:'1000',distributionChannel:'10',division:'00',currency:'NZD',expectedNetAmount:10,items:[{productId:'SOURCE-42',quantity:'2.000',unit:'EA'}]};
test('SAP create commands require server-owned approval metadata before any source call',async()=>{
  const f=fixture();for(const name of ['create_product','create_sales_order'])await assert.rejects(()=>f.tool(name).run(name==='create_product'?product:order),/verified exact SAP command approval/);assert.equal(f.stats().calls,0);
});
test('product creation reads back exact fields/description and reconciles a lost response without a duplicate',async()=>{
  const f=fixture(true),first=await f.tool('create_product').run(product,grant),again=await f.tool('create_product').run(product,grant);
  assert.equal(first.created,true);assert.equal(first.reconciled,true);assert.equal(again.created,false);assert.equal(again.record.productId,product.productId);assert.equal(f.stats().productCreates,1);
  await assert.rejects(()=>f.tool('create_product').run({...product,baseUnit:'KG'},grant),/different reviewed/);assert.equal(f.stats().productCreates,1);
});
test('sales-order receipt verifies actual lines/currency and preserves native ERP pricing',async()=>{
  const f=fixture(true,'12.50'),first=await f.tool('create_sales_order').run(order,grant),again=await f.tool('create_sales_order').run(order,grant);
  assert.equal(first.created,true);assert.equal(first.quoteParity.matches,false);assert.equal(first.record.netAmount,'12.50');assert.equal(first.record.currency,'NZD');assert.equal(first.record.deliveryStatus,undefined);
  assert.equal(again.created,false);assert.equal(f.stats().orderCreates,1);
  f.order.to_Item[0].RequestedQuantity='3.000';await assert.rejects(()=>f.tool('create_sales_order').run(order,grant),/different source lines/);assert.equal(f.stats().orderCreates,1);
});
test('SAP command inputs do not invent plant, product type, unit, customer or source reference',async()=>{
  const f=fixture();await assert.rejects(()=>f.tool('create_product').run({...product,productType:''},grant),/SAP product type/);
  await assert.rejects(()=>f.tool('create_sales_order').run({...order,customerId:''},grant),/SAP sold-to ID/);
  await assert.rejects(()=>f.tool('create_sales_order').run({...order,customerReference:'x'.repeat(36)},grant),/customer order reference/);
  await assert.rejects(()=>f.tool('create_sales_order').run({...order,referenceDocument:''},grant),/reference sales document/);
  await assert.rejects(()=>f.tool('create_sales_order').run({...order,items:[{...order.items[0],quantity:'NaN'}]},grant),/positive bounded decimal/);assert.equal(f.stats().calls,0);
});
test('a reviewed reference sales document is part of the exact source receipt',async()=>{
  const f=fixture();const args={...order,referenceDocument:'12345'};
  const first=await f.tool('create_sales_order').run(args,grant);assert.equal(first.created,true);
  await assert.rejects(()=>f.tool('create_sales_order').run({...args,referenceDocument:'12346'},grant),/different reviewed header/);
  assert.equal(f.stats().orderCreates,1);
});
