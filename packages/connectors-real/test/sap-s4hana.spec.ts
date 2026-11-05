import '../../jax-iq/test/setup/no-world';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sapS4hana } from '../src/connectors/sap-s4hana';
import { SapODataClient } from '../src/connectors/sap-odata';
const env = { SAP_S4HANA_API_URL: 'https://fixture-api.s4hana.cloud.sap', SAP_S4HANA_USERNAME: 'FIXTURE_API', SAP_S4HANA_PASSWORD: 'fixture-password-not-real', SAP_S4HANA_ORDER_SERVICE: '/sap/opu/odata/sap/API_SALES_ORDER_SRV' };
const deps = (read: (url: URL, init: RequestInit) => Response | Promise<Response>) => ({ now: Date.now, fetchImpl: (async (url: any, init: any) => read(new URL(String(url)), init)) as typeof fetch });

test('SAP reads are exact, bounded and do not traverse source-provided next links', async () => {
  let calls = 0;
  const adapter = sapS4hana(env, deps((url, init) => {
    calls++; assert.equal(init.method, 'GET'); assert.equal(url.hostname, 'fixture-api.s4hana.cloud.sap');
    assert.equal(url.searchParams.get('$filter'), "PurchaseOrderByCustomer eq 'O''Brien-12'");
    assert.equal(url.searchParams.get('$top'), '2');
    return Response.json({ d: { results: [{ SalesOrder: '123', PurchaseOrderByCustomer: "O'Brien-12", TransactionCurrency: 'NZD', TotalNetAmount: '10.50', OverallSDProcessStatus: 'A' }], __next: 'https://another-tenant.example/private' } });
  }));
  const result = await adapter.tools.find(t => t.name === 'find_orders')!.run({ customerReference: "O'Brien-12", limit: 2 });
  assert.equal(calls, 1); assert.equal(result.more, true); assert.equal(result.records[0].currency, 'NZD'); assert.equal(result.records[0].netAmount, '10.50');
  assert.equal(result.records[0].deliveryStatus, undefined); assert.equal(result.sample, false);
});
test('SAP cannot leak another source customer/order if it ignores the requested filter', async () => {
  const adapter = sapS4hana(env, deps(() => Response.json({ d: { results: [{ SalesOrder: 'someone-elses-order' }] } })));
  await assert.rejects(() => adapter.tools.find(t => t.name === 'get_order')!.run({ orderId: '123' }), /outside the exact/);
});
test('SAP missing APIs, broad reads and insecure endpoints fail before any vendor request', async () => {
  let calls = 0; const fake = deps(() => { calls++; throw new Error('must not call'); });
  await assert.rejects(() => sapS4hana(env, fake).tools.find(t => t.name === 'find_orders')!.run({}), /exact customer or order/);
  await assert.rejects(() => sapS4hana(env, fake).tools.find(t => t.name === 'get_stock')!.run({ productId: 'P1' }), /arrangement/);
  await assert.rejects(() => new SapODataClient({ ...env, SAP_S4HANA_API_URL: 'http://fixture.example' }, fake).metadata(env.SAP_S4HANA_ORDER_SERVICE), /HTTPS API origin/);
  assert.equal(calls, 0);
});
test('SAP CSRF sessions and cookies stay within the configured API service and out of results', async () => {
  const requests: URL[] = [];
  const client = new SapODataClient(env, deps((url, init) => {
    requests.push(url);
    if (init.method === 'GET') return new Response('<edmx:Edmx/>', { headers: { 'x-csrf-token': 'private-csrf-token', 'set-cookie': 'SAP_SESSIONID=private-session; Path=/; Secure, sap-usercontext=sap-client=100; Path=/' } });
    const headers = new Headers(init.headers); assert.equal(headers.get('x-csrf-token'), 'private-csrf-token'); assert.equal(headers.get('cookie'), 'SAP_SESSIONID=private-session; sap-usercontext=sap-client=100');
    return Response.json({ d: { SalesOrder: '456' } }, { status: 201 });
  }));
  const result = await client.create(env.SAP_S4HANA_ORDER_SERVICE, 'A_SalesOrder', { SalesOrderType: 'approved-type' });
  assert.deepEqual(result, { SalesOrder: '456' }); assert.equal(requests.length, 2); assert.ok(requests.every(url => url.origin === env.SAP_S4HANA_API_URL));
});
test('SAP does not post without its CSRF cookie or expose authentication in vendor errors', async () => {
  let posts = 0;
  const client = new SapODataClient(env, deps((_url, init) => { if (init.method === 'POST') posts++; return new Response('<edmx:Edmx/>', { headers: { 'x-csrf-token': 'private' } }); }));
  await assert.rejects(() => client.create(env.SAP_S4HANA_ORDER_SERVICE, 'A_SalesOrder', {}), /nothing was created/); assert.equal(posts, 0);
  const failed = new SapODataClient(env, deps(() => Response.json({ error: { message: env.SAP_S4HANA_PASSWORD } }, { status: 403 })));
  try { await failed.metadata(env.SAP_S4HANA_ORDER_SERVICE); assert.fail('should refuse'); } catch (error: any) { assert.doesNotMatch(error.message, /fixture-password/); }
});
test('Product V4 updates use the exact source ETag and never wildcard or overwrite a changed precondition',async()=>{
  const service='/sap/opu/odata4/sap/api_product/srvd_a2x/sap/product/0003';let patches=0;
  const client=new SapODataClient(env,deps((url,init)=>{
    if(url.pathname.endsWith('$metadata'))return new Response('<edmx:Edmx/>',{headers:{'x-csrf-token':'csrf','set-cookie':'SAP_SESSIONID=fixture; Secure'}});
    assert.ok(url.pathname.includes("ProductPlantSales(Product='JAX_OWNED',Plant='1000')"));
    if(init.method==='PATCH'){patches++;assert.equal(new Headers(init.headers).get('if-match'),'W/"source-version"');assert.deepEqual(JSON.parse(String(init.body)),{LoadingGroup:'0001'});return new Response(null,{status:204});}
    return Response.json({Product:'JAX_OWNED',Plant:'1000',LoadingGroup:'','@odata.etag':'W/"source-version"'});
  }));
  await client.patch(service,'ProductPlantSales',{Product:'JAX_OWNED',Plant:'1000'},{LoadingGroup:''},{LoadingGroup:'0001'});assert.equal(patches,1);
  await assert.rejects(()=>client.patch(service,'ProductPlantSales',{Product:'JAX_OWNED',Plant:'1000'},{LoadingGroup:'changed'},{LoadingGroup:'0001'}),/changed before the approved/);assert.equal(patches,1);
  const noTag=new SapODataClient(env,deps(()=>Response.json({Product:'JAX_OWNED',Plant:'1000',LoadingGroup:''})));
  await assert.rejects(()=>noTag.patch(service,'ProductPlantSales',{Product:'JAX_OWNED',Plant:'1000'},{LoadingGroup:''},{LoadingGroup:'0001'}),/no unconditional overwrite/);
});
