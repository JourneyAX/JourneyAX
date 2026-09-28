import assert from 'node:assert/strict';
import { TurnSearchMemo } from '../src/agent.service';
import { adapterRegistry } from '@journeyax/integration';

console.log('🧪 Running TurnSearchMemo Filter Separation & Concurrency Test Suite...');

async function runTests() {
  const originalGetKnowledge = adapterRegistry.getKnowledge.bind(adapterRegistry);

  try {
    // -------------------------------------------------------------------------
    // Test 1: Incompatible type filter separation (product vs installation)
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 1: Incompatible type filter separation never reuses cache');
      let searchCalls = 0;
      adapterRegistry.getKnowledge = async (tenantId: string) => ({
        search: async (_ctx: any, opts: any) => {
          searchCalls++;
          return { found: true, results: [{ sku: `SKU-${opts.type}`, title: `Result for ${opts.type}` }] };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      const r1 = await memo.search({ query: 'fasteners', type: 'product' });
      const r2 = await memo.search({ query: 'fasteners', type: 'installation' });

      assert.equal(searchCalls, 2, 'Search must be called twice for different types');
      assert.equal(r1.results[0].sku, 'SKU-product');
      assert.equal(r2.results[0].sku, 'SKU-installation');

      const records = memo.getRecords();
      assert.equal(records.length, 2);
      assert.equal(records[0].reused, false);
      assert.equal(records[1].reused, false);
      assert.equal(records[0].type, 'product');
      assert.equal(records[1].type, 'installation');
      console.log('    ✔ Passed: product vs installation executed independently without reuse');
    }

    // -------------------------------------------------------------------------
    // Test 2: Incompatible category filter separation (framing vs decking)
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 2: Incompatible category filter separation never reuses cache');
      let searchCalls = 0;
      adapterRegistry.getKnowledge = async (tenantId: string) => ({
        search: async (_ctx: any, opts: any) => {
          searchCalls++;
          return { found: true, results: [{ category: opts.category }] };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      const r1 = await memo.search({ query: 'treated pine', type: 'product', category: 'framing' });
      const r2 = await memo.search({ query: 'treated pine', type: 'product', category: 'decking' });

      assert.equal(searchCalls, 2, 'Search must be called twice for different categories');
      assert.equal(r1.results[0].category, 'framing');
      assert.equal(r2.results[0].category, 'decking');

      const records = memo.getRecords();
      assert.equal(records[0].category, 'framing');
      assert.equal(records[1].category, 'decking');
      assert.equal(records[0].reused, false);
      assert.equal(records[1].reused, false);
      console.log('    ✔ Passed: framing vs decking executed independently without reuse');
    }

    // -------------------------------------------------------------------------
    // Test 3: Incompatible gender filter separation (men vs women)
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 3: Incompatible gender filter separation never reuses cache');
      let searchCalls = 0;
      adapterRegistry.getKnowledge = async (tenantId: string) => ({
        search: async (_ctx: any, opts: any) => {
          searchCalls++;
          return { found: true, results: [{ gender: opts.gender }] };
        },
      } as any);

      const memo = new TurnSearchMemo('caroma');
      const r1 = await memo.search({ query: 'work boots', gender: 'men' });
      const r2 = await memo.search({ query: 'work boots', gender: 'women' });

      assert.equal(searchCalls, 2, 'Search must be called twice for different genders');
      assert.equal(r1.results[0].gender, 'men');
      assert.equal(r2.results[0].gender, 'women');

      const records = memo.getRecords();
      assert.equal(records[0].gender, 'men');
      assert.equal(records[1].gender, 'women');
      assert.equal(records[0].reused, false);
      assert.equal(records[1].reused, false);
      console.log('    ✔ Passed: men vs women executed independently without reuse');
    }

    // -------------------------------------------------------------------------
    // Test 4: Cross-tenant isolation (placemakers vs caroma)
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 4: Cross-tenant isolation never reuses across tenants');
      const tenantCalls: Record<string, number> = { placemakers: 0, caroma: 0 };
      adapterRegistry.getKnowledge = async (tenantId: string) => ({
        search: async (_ctx: any, _opts: any) => {
          tenantCalls[tenantId] = (tenantCalls[tenantId] || 0) + 1;
          return { found: true, tenant: tenantId };
        },
      } as any);

      const memoPlacemakers = new TurnSearchMemo('placemakers');
      const memoCaroma = new TurnSearchMemo('caroma');

      const rPlacemakers = await memoPlacemakers.search({ query: 'vessel basin 500mm', type: 'product' });
      const rCaroma = await memoCaroma.search({ query: 'vessel basin 500mm', type: 'product' });

      assert.equal(tenantCalls.placemakers, 1, 'Placemakers must execute search on placemakers tenant');
      assert.equal(tenantCalls.caroma, 1, 'Caroma must execute search on caroma tenant');
      assert.equal(rPlacemakers.tenant, 'placemakers');
      assert.equal(rCaroma.tenant, 'caroma');
      assert.equal(memoPlacemakers.getTenantId(), 'placemakers');
      assert.equal(memoCaroma.getTenantId(), 'caroma');
      console.log('    ✔ Passed: cross-tenant isolation guaranteed');
    }

    // -------------------------------------------------------------------------
    // Test 5: Exact normalized true duplicate collapsing reuses single in-flight promise
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 5: Exact normalized true duplicate collapsing');
      let searchCalls = 0;
      adapterRegistry.getKnowledge = async (_tenantId: string) => ({
        search: async (_ctx: any, _opts: any) => {
          searchCalls++;
          // Simulate realistic network delay
          await new Promise((resolve) => setTimeout(resolve, 30));
          return { found: true, callId: searchCalls };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      // Fire duplicate queries concurrently with slight formatting variations (extra spaces, casing)
      const p1 = memo.search({ query: 'framing timber 90x45', type: 'product' });
      const p2 = memo.search({ query: '  framing   timber   90x45  ', type: 'product' });
      const p3 = memo.search({ query: 'FRAMING TIMBER 90X45', type: 'product' });

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

      assert.equal(searchCalls, 1, 'Backend search should only be called once for identical normalized query');
      assert.equal(r1.callId, 1);
      assert.equal(r2.callId, 1);
      assert.equal(r3.callId, 1);

      const records = memo.getRecords();
      assert.equal(records.length, 3);
      assert.equal(records[0].reused, false);
      assert.equal(records[1].reused, true);
      assert.equal(records[2].reused, true);
      assert.equal(records[1].durationMs, 0);
      assert.equal(records[2].durationMs, 0);
      console.log('    ✔ Passed: exact normalized true duplicates collapsed to single promise');
    }

    // -------------------------------------------------------------------------
    // Test 6: Sibling concurrent queries run concurrently without blocking
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 6: Sibling concurrent queries run concurrently');
      let maxActiveConcurrent = 0;
      let active = 0;

      adapterRegistry.getKnowledge = async (_tenantId: string) => ({
        search: async (_ctx: any, _opts: any) => {
          active++;
          if (active > maxActiveConcurrent) maxActiveConcurrent = active;
          await new Promise((resolve) => setTimeout(resolve, 40));
          active--;
          return { found: true };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      // 1 product search + 2 installation searches
      const p1 = memo.search({ query: 'decking screws 65mm', type: 'product' });
      const p2 = memo.search({ query: 'decking screw spacing installation guide', type: 'installation' });
      const p3 = memo.search({ query: 'subfloor joist installation requirements', type: 'installation' });

      const tStart = Date.now();
      await Promise.all([p1, p2, p3]);
      const elapsed = Date.now() - tStart;

      assert.equal(maxActiveConcurrent, 3, 'All 3 queries should be in-flight concurrently');
      // If run serially, 3 * 40ms = 120ms+. When concurrent, ~40-60ms.
      assert.ok(elapsed < 100, `Concurrent elapsed ${elapsed}ms should be well below serial 120ms`);
      console.log(`    ✔ Passed: 3 queries executed concurrently in ${elapsed}ms (max concurrent: ${maxActiveConcurrent})`);
    }

    // -------------------------------------------------------------------------
    // Test 7: Limit separation negative test
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 7: Limit separation never reuses across different limits');
      let searchCalls = 0;
      adapterRegistry.getKnowledge = async (_tenantId: string) => ({
        search: async (_ctx: any, opts: any) => {
          searchCalls++;
          return { found: true, limit: opts.limit, results: new Array(opts.limit).fill(0).map((_, i) => ({ id: i })) };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      const r1 = await memo.search({ query: 'plasterboard screws', type: 'product', limit: 2 });
      const r2 = await memo.search({ query: 'plasterboard screws', type: 'product', limit: 8 });

      assert.equal(searchCalls, 2, 'Different limits must trigger independent searches');
      assert.equal(r1.results.length, 2);
      assert.equal(r2.results.length, 8);

      const records = memo.getRecords();
      assert.equal(records.length, 2);
      assert.equal(records[0].reused, false);
      assert.equal(records[1].reused, false);
      console.log('    ✔ Passed: limit 2 vs limit 8 executed independently without reuse');
    }

    // -------------------------------------------------------------------------
    // Test 8: Rejected search / failure propagation & no successful 0ms reuse
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 8: Failure propagation & no successful 0ms reuse on error');
      let callCount = 0;
      adapterRegistry.getKnowledge = async (_tenantId: string) => ({
        search: async (_ctx: any, _opts: any) => {
          callCount++;
          if (callCount === 1) {
            await new Promise((r) => setTimeout(r, 20));
            throw new Error('Atlas search connection timeout');
          }
          return { found: true, recovered: true };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      const p1 = memo.search({ query: 'temporary outage query', type: 'product' });
      const p2 = memo.search({ query: 'temporary outage query', type: 'product' });

      let err1: any;
      let err2: any;
      try { await p1; } catch (e) { err1 = e; }
      try { await p2; } catch (e) { err2 = e; }

      assert.ok(err1, 'Primary in-flight caller must receive rejection');
      assert.ok(err2, 'Concurrent duplicate caller must receive rejection');
      assert.equal(err1.message, 'Atlas search connection timeout');
      assert.equal(err2.message, 'Atlas search connection timeout');

      // Failed work must NOT be recorded as a successful 0ms reuse
      const records = memo.getRecords();
      const successfulReuses = records.filter((r) => r.reused);
      assert.equal(successfulReuses.length, 0, 'No successful 0ms reuse record should exist for failed work');

      // The failed entry must be evicted, allowing a subsequent fresh attempt
      const recovered = await memo.search({ query: 'temporary outage query', type: 'product' });
      assert.equal(recovered.recovered, true, 'Subsequent search should retry freshly after failure eviction');
      console.log('    ✔ Passed: failure propagated to all callers and not recorded as 0ms reuse');
    }

    // -------------------------------------------------------------------------
    // Test 9: Result equivalence & call order preservation after concurrent orchestration
    // -------------------------------------------------------------------------
    {
      console.log('  ▸ Test 9: Result equivalence and original call order preservation');
      adapterRegistry.getKnowledge = async (_tenantId: string) => ({
        search: async (_ctx: any, opts: any) => {
          // Delay differently to test that completion order does not alter output order
          const delay = opts.query.includes('guide') ? 30 : 15;
          await new Promise((r) => setTimeout(r, delay));
          return {
            found: true,
            query: opts.query,
            type: opts.type,
            results: [{ sku: opts.type === 'product' ? 'SKU-AQUALINE' : 'DOC-NZBC-E3' }],
          };
        },
      } as any);

      const memo = new TurnSearchMemo('placemakers');
      const toolCalls = [
        { id: 'call_prod_1', function: { name: 'searchKnowledge', arguments: JSON.stringify({ query: 'GIB Aqualine 10mm', type: 'product' }) } },
        { id: 'call_install_2', function: { name: 'searchKnowledge', arguments: JSON.stringify({ query: 'NZBC E3/AS1 wet area guide', type: 'installation' }) } },
        { id: 'call_prod_3_dup', function: { name: 'searchKnowledge', arguments: JSON.stringify({ query: 'gib aqualine 10mm', type: 'product' }) } },
      ];

      // Pre-launch all searches concurrently as done in processChat/processChatStream
      const orchestratedResults = await Promise.all(
        toolCalls.map(async (call) => {
          const args = JSON.parse(call.function.arguments);
          const result = await memo.search({ query: args.query, type: args.type });
          return {
            tool_call_id: call.id,
            result,
          };
        })
      );

      // Verify that all results match original call order
      assert.equal(orchestratedResults[0].tool_call_id, 'call_prod_1');
      assert.equal(orchestratedResults[1].tool_call_id, 'call_install_2');
      assert.equal(orchestratedResults[2].tool_call_id, 'call_prod_3_dup');

      // Verify result equivalence between exact normalized duplicate queries
      assert.deepEqual(
        orchestratedResults[0].result,
        orchestratedResults[2].result,
        'Duplicate calls must return identical equivalent grounded results'
      );
      // Verify different type produces different grounded result
      assert.notDeepEqual(
        orchestratedResults[0].result,
        orchestratedResults[1].result,
        'Different types must have distinct grounded results'
      );
      console.log('    ✔ Passed: all tool_call_id results remain in original order with equivalent data');
    }

    console.log('🎉 All TurnSearchMemo tests passed successfully!\n');
  } finally {
    adapterRegistry.getKnowledge = originalGetKnowledge;
  }
}

runTests().catch((err) => {
  console.error('❌ Test failed:', err);
  process.exit(1);
});
