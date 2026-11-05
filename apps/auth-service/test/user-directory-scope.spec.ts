import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthController } from '../src/auth.controller';
test('the user directory requires verified administrative identity and scopes tenant administrators', async () => {
  const reads: any[] = []; const service: any = { verify: async () => ({ valid: true, payload: { sub: 'actor', role: 'buyer', tenantId: 'merchant-a' } }), getUsers: async (tenant: string) => { reads.push(tenant); return []; } };
  const controller = new AuthController(service);
  await assert.rejects(() => controller.getUsers(undefined), /Sign in/);
  await assert.rejects(() => controller.getUsers(undefined, 'Bearer valid'), /administration/);
  service.verify = async () => ({ valid: true, payload: { sub: 'actor', role: 'admin', tenantId: 'merchant-a' } });
  await controller.getUsers(undefined, 'Bearer valid'); assert.deepEqual(reads, ['merchant-a']);
  await assert.rejects(() => controller.getUsers('merchant-b', 'Bearer valid'), /outside/); assert.equal(reads.length, 1);
});
