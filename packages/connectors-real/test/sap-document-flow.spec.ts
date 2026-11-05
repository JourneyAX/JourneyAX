import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
const env={SAP_S4HANA_API_URL:'https://fixture-api.s4hana.cloud.sap',SAP_S4HANA_USERNAME:'fixture',SAP_S4HANA_PASSWORD:'fixture-secret',SAP_S4HANA_ORDER_SERVICE:'/sap/opu/odata/sap/API_SALES_ORDER_SRV',SAP_S4HANA_DELIVERY_SERVICE:'/sap/opu/odata/sap/API_OUTBOUND_DELIVERY_SRV;v=0002'};
test('delivery and subsequent-document reads preserve exact native references/status without fabricated outcomes',async()=>{
  const adapter=sapS4hana(env,{now:Date.now,fetchImpl:(async(url:any)=>{
    const target=new URL(String(url));assert.equal(target.searchParams.get('$top'),target.pathname.endsWith('A_OutbDeliveryHeader')?'2':'50');
    if(target.pathname.endsWith('A_SalesOrderSubsqntProcFlow'))return Response.json({d:{results:[]}});
    assert.equal(target.searchParams.get('$filter'),"DeliveryDocument eq '80000001'");
    return Response.json({d:{results:[{DeliveryDocument:'80000001',OverallGoodsMovementStatus:'A',BillOfLading:''}]}});
  })as typeof fetch});
  const flow=await adapter.tools.find(tool=>tool.name==='get_order_document_flow')!.run({orderId:'123'});assert.deepEqual(flow.records,[]);assert.equal(flow.returned,0);
  const delivery=await adapter.tools.find(tool=>tool.name==='get_delivery')!.run({deliveryId:'80000001'});assert.equal(delivery.record.OverallGoodsMovementStatus,'A');assert.equal(delivery.record.delivered,undefined);assert.equal(delivery.record.paymentStatus,undefined);
});
test('another delivery or an unbounded/missing identifier is withheld',async()=>{
  let calls=0;const adapter=sapS4hana(env,{now:Date.now,fetchImpl:(async()=>{calls++;return Response.json({d:{results:[{DeliveryDocument:'other'}]}});})as typeof fetch});
  await assert.rejects(()=>adapter.tools.find(tool=>tool.name==='get_delivery_items')!.run({deliveryId:'80000001'}),/outside the exact/);
  await assert.rejects(()=>adapter.tools.find(tool=>tool.name==='get_delivery')!.run({deliveryId:'x'.repeat(11)}),/exact SAP delivery ID/);assert.equal(calls,1);
});
