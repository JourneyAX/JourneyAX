import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryDb } from '@journeyax/test-support';
import { OutboxRepository } from '../src/outbox';

test('a development worker cannot lease production or another tenant events in a shared database', async()=>{
 const db=new MemoryDb();const repo=new OutboxRepository(db as any);
 for(const[tenantId,environmentId]of [['tenant-a','production'],['tenant-b','dev'],['tenant-a','dev']] as const)await repo.enqueue({tenantId,environmentId,eventType:'commerce.order_paid',payload:{}});
 const claimed=await repo.claimLeases('local-worker',30000,10,{tenantId:'tenant-a',environmentId:'dev'});
 assert.equal(claimed.length,1);assert.equal(claimed[0].tenantId,'tenant-a');assert.equal(claimed[0].environmentId,'dev');
 assert.equal(db.dump('outbox_events').filter(row=>row.status==='pending').length,2);
 await assert.rejects(()=>repo.claimLeases('invalid-worker',30000,10,{environmentId:'unknown'}),/Unsupported/);
});
