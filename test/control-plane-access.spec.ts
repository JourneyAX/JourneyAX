import '../packages/jax-iq/test/setup/no-world';
import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { signGatewayAssertion, authenticateServiceIdentity } from '@journeyax/database';
import { AnalyticsAccessGuard } from '../apps/analytics-service/src/access.guard';
import { OrganizationAccessGuard } from '../apps/organization-service/src/access.guard';

const secret = 'isolated-control-plane-identity-secret-'.repeat(2);
const signed = (tenantId: string, role: 'admin'|'manager'|'customer' = 'manager') => signGatewayAssertion({ tenantId, environmentId: 'production', sub: 'verified-person', role }, secret);
const context = (req: any, name = 'getInsights') => { const handler = { [name]: () => {} }[name]; return { getHandler: () => handler, switchToHttp: () => ({ getRequest: () => req }) } as any; };

test('shared service identity refuses forged internal/role headers and unavailable JWT verification', async () => {
  await assert.rejects(() => authenticateServiceIdentity({ 'x-user-role':'admin', 'x-internal-call':'true' }, { authUrl:'https://auth.invalid' }), /Verified service identity/);
  await assert.rejects(() => authenticateServiceIdentity({ authorization:'Bearer fixture' }, { authUrl:'https://auth.invalid', fetchImpl:(async()=>{throw new Error('offline');}) as typeof fetch }), /unavailable/);
  const identity = await authenticateServiceIdentity({ 'x-gateway-assertion':signed('tenant-a') }, { authUrl:'https://auth.invalid', assertionSecret:secret, expectedTenantId:'tenant-a' });
  assert.equal(identity.tenantId,'tenant-a'); assert.equal(identity.role,'manager');
  await assert.rejects(() => authenticateServiceIdentity({ 'x-gateway-assertion':signed('tenant-a') }, { authUrl:'https://auth.invalid', assertionSecret:secret, expectedTenantId:'tenant-b' }));
});

test('analytics verifies identity and replaces spoofable privilege headers before any data read', async () => {
  const previous=process.env.GATEWAY_ASSERTION_SECRET; process.env.GATEWAY_ASSERTION_SECRET=secret;
  try {
    const guard=new AnalyticsAccessGuard();
    await assert.rejects(()=>guard.canActivate(context({headers:{'x-tenant-id':'tenant-a','x-user-role':'admin','x-user-email':'forged','x-internal-call':'true'},query:{projectId:'tenant-a'}})),/Verified analytics/);
    const req:any={headers:{'x-tenant-id':'tenant-a','x-gateway-assertion':signed('tenant-a'),'x-user-role':'admin','x-user-permissions':'*','x-internal-call':'true'},query:{projectId:'tenant-a'}};
    assert.equal(await guard.canActivate(context(req)),true);assert.equal(req.headers['x-user-role'],'manager');assert.equal(req.headers['x-user-email'],'verified-person');assert.equal(req.headers['x-internal-call'],undefined);assert.notEqual(req.headers['x-user-permissions'],'*');
    req.query.projectId='tenant-b';await assert.rejects(()=>guard.canActivate(context(req)),/Verified analytics/);
    req.query={tenantId:'tenant-a',projectId:'tenant-b'};await assert.rejects(()=>guard.canActivate(context(req)),/One explicit/);
  } finally {if(previous===undefined)delete process.env.GATEWAY_ASSERTION_SECRET;else process.env.GATEWAY_ASSERTION_SECRET=previous;}
});

test('organisation billing cannot be enumerated by tenant admins or an unsigned direct caller',async()=>{
  const previous=process.env.GATEWAY_ASSERTION_SECRET;process.env.GATEWAY_ASSERTION_SECRET=secret;
  try {
    const guard=new OrganizationAccessGuard();
    await assert.rejects(()=>guard.canActivate(context({headers:{'x-user-role':'admin'}},'listOrgs')),/Verified platform/);
    await assert.rejects(()=>guard.canActivate(context({headers:{'x-tenant-id':'tenant-a','x-gateway-assertion':signed('tenant-a','admin')}},'listOrgs')),/Verified platform/);
    assert.equal(await guard.canActivate(context({headers:{'x-tenant-id':'platform','x-gateway-assertion':signed('platform','admin')}},'listOrgs')),true);
    assert.equal(await guard.canActivate(context({headers:{}},'health')),true);
  } finally {if(previous===undefined)delete process.env.GATEWAY_ASSERTION_SECRET;else process.env.GATEWAY_ASSERTION_SECRET=previous;}
});
