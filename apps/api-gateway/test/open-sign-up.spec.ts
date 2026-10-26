import assert from 'node:assert/strict';
import { createSuite } from '@journeyax/test-support';
import { GatewayService, isRegistrationPath } from '../src/gateway.service';
import { projectAllowed } from '../src/auth.guard';

process.env.NODE_ENV = 'test';
process.env.DISABLE_GCP_AUTH = 'true';

const suite = createSuite('api-gateway: open sign-up only makes a customer in a real project');

/** The projects the pretend project service knows about. */
const REAL_PROJECTS = new Set(['shopfront', 'second-shop']);

interface Call { url: string; method: string; body: any }

/** Stands in for the network: the project service knows REAL_PROJECTS, the sign-in service says created, and `projectsDown` makes the project service unreachable. */
function pretendNetwork(options: { projectsDown?: boolean } = {}) {
  const calls: Call[] = [];
  const original = global.fetch;
  (global as any).fetch = async (url: string, init: any = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const published = /\/api\/v1\/projects\/([^/]+)\/published$/.exec(url);
    if (published) {
      if (options.projectsDown) throw new Error('connect ECONNREFUSED');
      const found = REAL_PROJECTS.has(decodeURIComponent(published[1]));
      return { ok: found, status: found ? 200 : 404, json: async () => (found ? { projectId: published[1] } : { message: 'not found' }) };
    }
    return { ok: true, status: 201, json: async () => ({ success: true }) };
  };
  return {
    calls,
    toAuthService: () => calls.filter((c) => c.url.includes('/api/v1/auth/')),
    toProjectService: () => calls.filter((c) => c.url.includes('/api/v1/projects/')),
    restore: () => { (global as any).fetch = original; },
  };
}

const person = { email: 'someone@example.com', password: 'a-long-enough-password', fullName: 'Some One' };
const REGISTER = '/api/v1/auth/register';
const REFUSED = 'tenantId must name a customer-facing project.';

async function main() {
  const service = new GatewayService();

  await suite.test('an anonymous caller asking to be an admin of the platform is refused at the gateway, and nothing is forwarded', async () => {
    const net = pretendNetwork();
    try {
      const result = await service.proxyRequest('POST', REGISTER, {}, { ...person, role: 'admin', tenantId: 'platform' });
      assert.equal(result.status, 400);
      assert.equal(result.data.message, REFUSED);
      assert.equal(net.calls.length, 0, 'neither the sign-in service nor the project service is called');
    } finally { net.restore(); }
  });

  await suite.test('every reserved or malformed tenant is refused with one message that does not list the reserved names, and nothing is forwarded', async () => {
    const tenants: unknown[] = [
      'platform', 'system', 'global', 'admin', 'root', 'internal', 'anonymous', 'guest', 'public',
      'PLATFORM', ' Platform ', 'sYsTeM', 'global\n',
      '', ' ', 'a b', '../platform', 'platform/', 'platform.', 'platform_', '%70latform', 'plat\u0000form', 'platform​', 'ｐlatform', 'platfоrm', 'x'.repeat(64),
      null, 42, true, ['platform'], { $ne: null }, { tenantId: 'platform' },
    ];
    for (const tenantId of tenants) {
      for (const role of ['admin', 'buyer', undefined]) {
        const net = pretendNetwork();
        try {
          const result = await service.proxyRequest('POST', REGISTER, {}, { ...person, role, tenantId });
          assert.equal(result.status, 400, `tenant ${JSON.stringify(tenantId)} with role ${role}`);
          assert.ok([REFUSED, 'email, password, tenantId, and fullName are required.'].includes(result.data.message), String(result.data.message));
          assert.ok(!/platform|system|global|reserved/i.test(result.data.message), 'the reply does not list the reserved names');
          assert.equal(net.toAuthService().length, 0, `tenant ${JSON.stringify(tenantId)} must not reach the sign-in service`);
        } finally { net.restore(); }
      }
    }
  });

  await suite.test('a body that is not an object is refused', async () => {
    for (const body of [undefined, null, 'platform', 7, ['admin'], {}]) {
      const net = pretendNetwork();
      try {
        const result = await service.proxyRequest('POST', REGISTER, {}, body);
        assert.equal(result.status, 400);
        assert.equal(net.toAuthService().length, 0);
      } finally { net.restore(); }
    }
  });

  await suite.test('a project that does not exist is refused, and the project service was asked about it', async () => {
    const net = pretendNetwork();
    try {
      const result = await service.proxyRequest('POST', REGISTER, {}, { ...person, tenantId: 'no-such-shop' });
      assert.equal(result.status, 400);
      assert.equal(result.data.message, REFUSED);
      assert.equal(net.toProjectService().length, 1);
      assert.equal(net.toAuthService().length, 0);
    } finally { net.restore(); }
  });

  await suite.test('with the project service unreachable, production fails closed: nobody is signed up into a project nobody could check', async () => {
    const before = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    const net = pretendNetwork({ projectsDown: true });
    try {
      const result = await service.proxyRequest('POST', REGISTER, {}, { ...person, tenantId: 'unverifiable-shop' });
      assert.equal(result.status, 400);
      assert.equal(net.toAuthService().length, 0);
    } finally { net.restore(); process.env.NODE_ENV = before; }
  });

  await suite.test('a real project goes through with a role and every other extra field dropped, and the tenant in the form the services store', async () => {
    const net = pretendNetwork();
    try {
      const result = await service.proxyRequest('POST', REGISTER, {}, {
        ...person, tenantId: ' ShopFront ',
        role: 'admin', isActive: false, passwordHash: 'x', permissions: ['user.manage'], groups: ['administrators'], _id: 'abc', createdAt: '1999-01-01',
      });
      assert.equal(result.status, 201);
      const forwarded = net.toAuthService();
      assert.equal(forwarded.length, 1);
      assert.deepEqual(Object.keys(forwarded[0].body).sort(), ['email', 'fullName', 'password', 'tenantId']);
      assert.equal(forwarded[0].body.tenantId, 'shopfront');
      assert.equal(forwarded[0].body.email, person.email);
    } finally { net.restore(); }
  });

  await suite.test('the same rules hold when the route is spelt with a trailing slash, a query string or repeated slashes', () => {
    for (const path of ['/api/v1/auth/register', '/api/v1/auth/register/', '/api/v1/auth/register?x=1', '/api/v1//auth//register', '/API/V1/AUTH/REGISTER', '/api/v1/auth/register#frag']) {
      assert.equal(isRegistrationPath(path), true, path);
    }
    for (const path of ['/api/v1/auth/login', '/api/v1/auth/registered', '/api/v1/auth/register/extra', '/api/v1/projects/register', '/api/v1/auth/users']) {
      assert.equal(isRegistrationPath(path), false, path);
    }
  });

  await suite.test('the other sign-in routes are forwarded untouched, with no project lookup', async () => {
    const net = pretendNetwork();
    try {
      const body = { email: 'someone@example.com', password: 'pw', tenantId: 'platform' };
      await service.proxyRequest('POST', '/api/v1/auth/login', {}, body);
      assert.equal(net.toProjectService().length, 0);
      assert.deepEqual(net.toAuthService()[0].body, body, 'login keeps working for the platform tenant: the admin signs in that way');
    } finally { net.restore(); }
  });

  await suite.test('the platform\'s own tenants still pass the gateway\'s tenant check for routes that are not sign-up, but are not projects', async () => {
    const net = pretendNetwork();
    try {
      const gateway = service as any;
      for (const tenant of ['platform', 'system', 'global']) {
        assert.equal(await gateway.validateTenant(tenant), true, `${tenant} passes the tenant check as before`);
        assert.equal(await gateway.isActiveProject(tenant), false, `${tenant} is not a project`);
      }
      assert.equal(await gateway.validateTenant('shopfront'), true);
      assert.equal(await gateway.validateTenant('no-such-shop-2'), false);
    } finally { net.restore(); }
  });

  await suite.test('an identity of a plain customer of one project cannot act on another project, while the platform admin still can', () => {
    assert.equal(projectAllowed('second-shop', 'buyer', 'shopfront'), false);
    assert.equal(projectAllowed('shopfront', 'buyer', 'shopfront'), true);
    assert.equal(projectAllowed('second-shop', 'admin', 'platform'), true, 'the seeded admin keeps its reach');
  });

  suite.finish();
}

main().catch((error) => { console.error(error); process.exit(1); });
