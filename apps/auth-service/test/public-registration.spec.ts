import 'reflect-metadata';
import assert from 'node:assert/strict';
import * as bcrypt from 'bcrypt';
import * as jwt from 'jsonwebtoken';
import { NestFactory } from '@nestjs/core';
import { createSuite, MemoryDb } from '@journeyax/test-support';
import { can, checkSelfServiceTenant, isPlatformTenantId, type Permission } from '@journeyax/shared-types';
import { AuthModule } from '../src/auth.module';
import { AuthService } from '../src/auth.service';
import { readPublicRegistration } from '../src/public-registration';
import { applyAdminSeed, planAdminSeed } from '../src/admin-seed';
import { projectAllowed } from '../../api-gateway/src/auth.guard';
import { DEMO_STAFF, applyDemoStaff, planDemoStaff } from '../../../scripts/placemakers/demo-staff';

process.env.JWT_SECRET = 'test-secret-for-the-sign-in-service-0123456789';

const suite = createSuite('auth-service: open registration only makes a customer in a real project');

/** Fast hashes for the test; the stored form is still a real bcrypt hash, so login verifies it. */
const quickHash = (password: string) => bcrypt.hash(password, 4);

const STAFF_ONLY: Permission[] = ['user.manage', 'user.read', 'config.edit', 'config.publish', 'project.list', 'secret.rotate', 'analytics.read', 'knowledge.ingest', 'knowledge.delete', 'order.manage'];
const person = { email: 'new.customer@example.com', password: 'a-long-enough-password', fullName: 'New Customer', tenantId: 'shopfront' };

async function startService() {
  const db = new MemoryDb();
  const app = await NestFactory.create(AuthModule, { logger: false });
  const service = app.get(AuthService);
  (service as any).db = db;
  service.hashPassword = quickHash;
  await app.listen(0, '127.0.0.1');
  const base = (await app.getUrl()).replace('[::1]', '127.0.0.1');
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${base}/api/v1/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json().catch(() => ({}))) as any };
  };
  return { db, service, post, close: () => app.close() };
}

async function main() {
  const rig = await startService();
  const users = () => rig.db.dump('users');

  await suite.test('an anonymous caller registering as admin of the platform is refused and nothing is stored', async () => {
    const res = await rig.post('register', { ...person, role: 'admin', tenantId: 'platform' });
    assert.equal(res.status, 400);
    assert.equal(users().length, 0);
  });

  await suite.test('whatever role is asked for, in whatever form, the account that comes out is a plain buyer', async () => {
    const roles: unknown[] = [
      'admin', 'manager', 'buyer', 'guest', 'cs', 'rep', 'owner', 'superadmin', 'root', 'operator',
      'Admin', 'ADMIN', ' admin ', 'admin\u0000', 'admin\n', '', 'null',
      null, 0, 1, true, false, ['admin'], { role: 'admin' }, { $ne: 'buyer' },
    ];
    let n = 0;
    for (const role of roles) {
      const email = `role.${n++}@example.com`;
      const res = await rig.post('register', { ...person, email, role });
      assert.equal(res.status, 201, `role ${JSON.stringify(role)}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.user.role, 'buyer', `role ${JSON.stringify(role)} must come out as buyer`);
      const stored = users().find((u) => u.email === email)!;
      assert.equal(stored.role, 'buyer', `stored role for ${JSON.stringify(role)}`);
      assert.equal(stored.tenantId, 'shopfront');
    }
    assert.equal(users().length, roles.length);
    assert.deepEqual([...new Set(users().map((u) => u.role))], ['buyer']);
  });

  await suite.test('a request that asks for a role and the platform tenant together is refused; the same request for a real project gives a buyer', async () => {
    const before = users().length;
    for (const role of ['admin', 'manager', 'cs', 'rep']) {
      const refused = await rig.post('register', { ...person, email: `x.${role}@example.com`, role, tenantId: 'platform' });
      assert.equal(refused.status, 400, role);
    }
    assert.equal(users().length, before);
    const ok = await rig.post('register', { ...person, email: 'real.project@example.com', role: 'admin' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.role, 'buyer');
  });

  await suite.test('every reserved or malformed tenant is refused, stores nothing, and the reply does not list the reserved names', async () => {
    const before = users().length;
    const tenants: unknown[] = [
      'platform', 'system', 'global', 'admin', 'root', 'internal', 'anonymous', 'guest', 'public',
      'PLATFORM', ' Platform ', 'sYsTeM', 'global\n',
      '', ' ', 'a b', '../platform', 'platform/', 'platform.', 'platform_', '%70latform', 'plat\u0000form', 'platform​', 'ｐlatform', 'platfоrm', 'x'.repeat(64),
      null, 42, true, ['platform'], { $ne: null }, { tenantId: 'platform' },
    ];
    for (const tenantId of tenants) {
      const res = await rig.post('register', { ...person, email: 'tenant.try@example.com', role: 'admin', tenantId });
      assert.equal(res.status, 400, `tenant ${JSON.stringify(tenantId)}: ${JSON.stringify(res.body)}`);
      assert.ok(!/platform|system|global|reserved/i.test(JSON.stringify(res.body.message)), 'the reply does not list the reserved names');
    }
    const missing = await rig.post('register', { email: person.email, password: person.password, fullName: person.fullName });
    assert.equal(missing.status, 400);
    assert.equal(users().length, before, 'nothing was stored');
  });

  await suite.test('the service refuses a platform tenant for any caller of register, not only the route', async () => {
    const before = users().length;
    for (const tenantId of ['platform', 'system', 'global', 'Platform', ' SYSTEM ']) {
      const result = await rig.service.register({ ...person, email: 'direct@example.com', tenantId });
      assert.equal(result.success, false, tenantId);
    }
    // a caller that smuggles a role past the type system still gets a buyer
    const smuggled = await rig.service.register({ ...person, email: 'smuggled@example.com', role: 'admin' } as any);
    assert.equal(smuggled.success, true);
    assert.equal(smuggled.user?.role, 'buyer');
    assert.equal(users().length, before + 1);
  });

  await suite.test('only the four named fields reach the stored document: an attempt to set the hash, the active flag, the dates or the id changes nothing', async () => {
    const res = await rig.post('register', {
      ...person, email: 'mass.assign@example.com', role: 'admin',
      isActive: false, passwordHash: 'chosen-by-the-caller', createdAt: '1999-01-01', lastLoginAt: '1999-01-01', _id: 'abc',
      permissions: ['user.manage'], groups: ['administrators'], isAdmin: true,
    });
    assert.equal(res.status, 201);
    assert.deepEqual(Object.keys(res.body.user).sort(), ['email', 'fullName', 'role', 'tenantId']);
    const stored = users().find((u) => u.email === 'mass.assign@example.com')!;
    assert.deepEqual(Object.keys(stored).filter((k) => k !== '_id').sort(), ['createdAt', 'email', 'fullName', 'isActive', 'passwordHash', 'role', 'tenantId']);
    assert.equal(stored.role, 'buyer');
    assert.equal(stored.isActive, true);
    assert.notEqual(stored.passwordHash, 'chosen-by-the-caller');
    assert.notEqual(stored._id, 'abc');
    assert.ok(stored.createdAt instanceof Date && stored.createdAt.getFullYear() > 2000);
    assert.equal(stored.lastLoginAt, undefined);
  });

  await suite.test('such an account signs in as a plain buyer of its own project: no staff permission, no reach into any other project', async () => {
    const login = await rig.post('login', { email: 'real.project@example.com', password: person.password });
    assert.equal(login.status, 201);
    const claims = jwt.decode(login.body.tokens.accessToken) as any;
    assert.equal(claims.role, 'buyer');
    assert.equal(claims.tenantId, 'shopfront');
    for (const permission of STAFF_ONLY) assert.equal(can(claims.role, permission), false, `a buyer must not hold ${permission}`);
    assert.equal(projectAllowed('shopfront', claims.role, claims.tenantId), true);
    assert.equal(projectAllowed('second-shop', claims.role, claims.tenantId), false);
    assert.equal(projectAllowed('platform', claims.role, claims.tenantId), false);
  });

  await suite.test('the tenant is stored the way the services read it, and the existing checks still hold: a second sign-up with the same e-mail, a short password, a missing field', async () => {
    const ok = await rig.post('register', { ...person, email: 'Mixed.Case@Example.com', tenantId: ' ShopFront ' });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.user.email, 'mixed.case@example.com');
    assert.equal(ok.body.user.tenantId, 'shopfront');
    const duplicate = await rig.post('register', { ...person, email: 'MIXED.case@example.com' });
    assert.equal(duplicate.status, 400);
    assert.match(duplicate.body.message, /already registered/);
    for (const [name, body] of Object.entries({
      'short password': { ...person, email: 'short@example.com', password: 'short' },
      'no e-mail': { ...person, email: undefined },
      'no name': { ...person, email: 'noname@example.com', fullName: '  ' },
      'e-mail without an @': { ...person, email: 'admin' },
      'name that is not text': { ...person, email: 'obj@example.com', fullName: { a: 1 } },
      'e-mail that is not text': { ...person, email: { $gt: '' } },
    })) {
      const res = await rig.post('register', body);
      assert.equal(res.status, 400, name);
    }
    assert.equal(users().some((u) => ['short@example.com', 'noname@example.com', 'obj@example.com', 'admin'].includes(u.email)), false);
  });

  await suite.test('the reading of a sign-up body is the same pure rule the route uses', () => {
    assert.deepEqual(readPublicRegistration({ ...person, role: 'admin' }), { status: 'ok', value: { email: person.email, password: person.password, tenantId: 'shopfront', fullName: person.fullName } });
    assert.equal(readPublicRegistration({ ...person, tenantId: 'platform' }).status, 'refused');
    assert.equal(readPublicRegistration(null).status, 'refused');
    assert.equal(readPublicRegistration('admin').status, 'refused');
    assert.equal(readPublicRegistration([person]).status, 'refused');
    assert.deepEqual(checkSelfServiceTenant('Shopfront'), { status: 'ok', tenantId: 'shopfront' });
    assert.deepEqual(checkSelfServiceTenant('platform'), { status: 'refused', reason: 'reserved' });
    assert.deepEqual(checkSelfServiceTenant('a b'), { status: 'refused', reason: 'malformed' });
    assert.deepEqual(checkSelfServiceTenant(undefined), { status: 'refused', reason: 'missing' });
    for (const tenant of ['platform', 'system', 'global']) {
      assert.equal(isPlatformTenantId(tenant), true);
      assert.equal(checkSelfServiceTenant(tenant).status, 'refused', `${tenant} is a platform tenant, so no sign-up may join it`);
    }
  });

  await suite.test('the admin seed still makes a working platform admin, which the open route can never make, and a sign-up cannot take its place', async () => {
    const seedDb = new MemoryDb();
    assert.throws(() => planAdminSeed({}), /credentials|ADMIN_EMAIL/);
    assert.throws(() => planAdminSeed({ NODE_ENV: 'production', ALLOW_INSECURE_DEV_ADMIN: 'true' }), /credentials|ADMIN_EMAIL/);
    assert.throws(() => planAdminSeed({ NODE_ENV: 'production', ADMIN_EMAIL: 'root@example.test', ADMIN_PASSWORD: 'admin' }), /credentials|ADMIN_EMAIL/);
    const plan = planAdminSeed({ NODE_ENV: 'test', ALLOW_INSECURE_DEV_ADMIN: 'true' });
    assert.deepEqual(plan, { email: 'admin', password: 'admin', tenantId: 'platform' });
    assert.deepEqual(planAdminSeed({ ADMIN_EMAIL: 'Root@Example.com', ADMIN_PASSWORD: 'long-password', ADMIN_TENANT: 'Platform' }), { email: 'root@example.com', password: 'long-password', tenantId: 'platform' });
    await applyAdminSeed(seedDb as any, plan, quickHash);
    await applyAdminSeed(seedDb as any, plan, quickHash);
    const seeded = seedDb.dump('users');
    assert.equal(seeded.length, 1, 'running it twice changes nothing but the hash');
    assert.deepEqual({ email: seeded[0].email, role: seeded[0].role, tenantId: seeded[0].tenantId, isActive: seeded[0].isActive }, { email: 'admin', role: 'admin', tenantId: 'platform', isActive: true });
    assert.ok(seeded[0].createdAt instanceof Date);

    // The seeded admin signs in through the real service and holds every permission and every project.
    const other = new MemoryDb();
    const boss = planAdminSeed({ ADMIN_EMAIL: 'boss@example.com', ADMIN_PASSWORD: 'long-password' });
    (rig.service as any).db = other;
    try {
      await applyAdminSeed(other as any, boss, quickHash);
      const login = await rig.post('login', { email: 'boss@example.com', password: 'long-password' });
      assert.equal(login.status, 201);
      const claims = jwt.decode(login.body.tokens.accessToken) as any;
      assert.deepEqual({ role: claims.role, tenantId: claims.tenantId }, { role: 'admin', tenantId: 'platform' });
      for (const permission of STAFF_ONLY) assert.equal(can(claims.role, permission), true, `admin holds ${permission}`);
      assert.equal(projectAllowed('any-project', claims.role, claims.tenantId), true);
      // A stranger cannot register over it: the same e-mail is refused whatever role, tenant or case is sent, and the stored hash is untouched.
      const before = other.dump('users')[0].passwordHash;
      for (const attempt of [
        { email: 'boss@example.com', role: 'admin', tenantId: 'platform' },
        { email: 'BOSS@example.com', role: 'admin' },
        { email: 'boss@example.com' },
      ]) {
        const res = await rig.post('register', { ...person, password: 'my-own-password', ...attempt });
        assert.equal(res.status, 400, JSON.stringify(attempt));
      }
      assert.equal(other.dump('users').length, 1);
      assert.equal(other.dump('users')[0].passwordHash, before);
      assert.equal((await rig.post('login', { email: 'boss@example.com', password: 'my-own-password' })).status, 401);
    } finally {
      (rig.service as any).db = rig.db;
    }
  });

  await suite.test('the demo staff script still makes working staff and customer logins (roles cs, rep, buyer), none of which the open route could make', async () => {
    const usersDb = new MemoryDb();
    const projectDb = new MemoryDb();
    const plan = planDemoStaff('shopfront');
    await applyDemoStaff({ users: usersDb as any, project: projectDb as any }, plan, quickHash);
    await applyDemoStaff({ users: usersDb as any, project: projectDb as any }, plan, quickHash);
    assert.equal(usersDb.dump('users').length, DEMO_STAFF.length, 'loading twice changes nothing');
    const roles = new Set(usersDb.dump('users').map((u) => u.role));
    assert.deepEqual([...roles].sort(), ['buyer', 'cs', 'rep']);

    const other = rig.service as any;
    const saved = other.db;
    other.db = usersDb;
    try {
      for (const demo of DEMO_STAFF) {
        const login = await rig.post('login', { email: demo.email, password: demo.password });
        assert.equal(login.status, 201, demo.email);
        const claims = jwt.decode(login.body.tokens.accessToken) as any;
        assert.deepEqual({ role: claims.role, tenantId: claims.tenantId }, { role: demo.role, tenantId: 'shopfront' }, demo.email);
      }
      // The same staff roles asked for through the open route come out as buyers, or are refused.
      for (const staff of DEMO_STAFF.filter((d) => d.role !== 'buyer')) {
        const res = await rig.post('register', { ...person, email: `again.${staff.email}`, role: staff.role });
        assert.equal(res.body.user.role, 'buyer', `${staff.role} through the open route`);
      }
    } finally {
      other.db = saved;
    }
  });

  await rig.close();
  suite.finish();
}

main().then(() => process.exit(process.exitCode ?? 0)).catch((error) => { console.error(error); process.exit(1); });
