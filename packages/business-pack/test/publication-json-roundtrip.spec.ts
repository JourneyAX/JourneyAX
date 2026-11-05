import '../../jax-iq/test/setup/no-world';
import test from 'node:test';
import assert from 'node:assert/strict';
import { BSON } from 'mongodb';
import { MemoryDb } from '@journeyax/test-support';
import { publishBusinessPack, verifyPersistedBusinessPackRelease } from '../src';
import { rawLegacyFixture } from './fixtures/legacy-pack.fixture';

test('optional undefined fields remain absent across actual BSON serialization of a published release', async () => {
  const content:any=structuredClone(rawLegacyFixture);
  if(content.catalogMapping?.pricing?.demoFallback) content.catalogMapping.pricing.demoFallback.enabled=false;
  content.modelPolicy.policies[0].residencyAttestation=undefined;
  content.modelPolicy.policies[0].candidates[0].temperature=undefined;
  const db=new MemoryDb(); const result=await publishBusinessPack(db as any,content);
  const stored=db.dump('business_pack_releases')[0];
  const reloaded=BSON.deserialize(BSON.serialize(stored));
  assert.equal(Object.prototype.hasOwnProperty.call(reloaded.modelPolicy.policies[0],'residencyAttestation'),false);
  const verified=verifyPersistedBusinessPackRelease(reloaded,{tenantId:content.manifest.tenantId,environmentId:content.manifest.environmentId,pointerChecksum:result.checksum});
  assert.equal(verified.checksum,result.checksum);
});
