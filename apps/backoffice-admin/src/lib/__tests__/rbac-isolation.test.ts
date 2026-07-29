/**
 * Negative tenant-isolation + RBAC tests (P0-02 R3).
 *
 * These assert the security-critical DECISION functions directly — the ones that
 * decide "may this subject do this action, on this tenant?" — so a regression that
 * re-opens cross-tenant access or privilege escalation fails loudly. Run with:
 *   npx tsx apps/backoffice-admin/src/lib/__tests__/rbac-isolation.test.ts
 */
import { can, requiredPermission, permissionsFor } from '@journeyax/shared-types';
import { scopeTenant, tenantAllowed, type AuthedIdentity } from '../require-auth';

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) { failures++; console.error(`✗ ${name}`); }
  else console.log(`✓ ${name}`);
}

const admin: AuthedIdentity   = { email: 'a@x', role: 'admin',   tenantId: 'platform', permissions: permissionsFor('admin') };
const caromaMgr: AuthedIdentity = { email: 'm@caroma', role: 'manager', tenantId: 'caroma', permissions: permissionsFor('manager') };
const caromaBuyer: AuthedIdentity = { email: 'b@caroma', role: 'buyer', tenantId: 'caroma', permissions: permissionsFor('buyer') };

// ── Cross-tenant isolation (the core enumeration fix) ──────────────────
check('tenant user pinned to own tenant despite query asking for augusta',
  scopeTenant(caromaMgr, 'augusta') === 'caroma');
check('tenant user pinned even with no query',
  scopeTenant(caromaBuyer, null) === 'caroma');
check('admin MAY target a specific project',
  scopeTenant(admin, 'augusta') === 'augusta');
check('tenant user cannot act on another tenant',
  tenantAllowed(caromaMgr, 'augusta') === false);
check('tenant user CAN act on own tenant',
  tenantAllowed(caromaMgr, 'caroma') === true);
check('admin can act on any tenant',
  tenantAllowed(admin, 'augusta') === true);
check('empty tenant is not allowed for a tenant user',
  tenantAllowed(caromaBuyer, '') === false);

// ── Privilege escalation is impossible ────────────────────────────────
check('buyer CANNOT edit config',           can('buyer', 'config.edit') === false);
check('buyer CANNOT ingest knowledge',      can('buyer', 'knowledge.ingest') === false);
check('buyer CANNOT delete knowledge',      can('buyer', 'knowledge.delete') === false);
check('manager CANNOT rotate secrets',      can('manager', 'secret.rotate') === false);
check('manager CANNOT manage users',        can('manager', 'user.manage') === false);
check('manager CAN publish config',         can('manager', 'config.publish') === true);
check('admin CAN rotate secrets',           can('admin', 'secret.rotate') === true);
check('unknown role collapses to guest',    can('superhacker' as any, 'config.edit') === false);
check('guest can only chat',                can('guest', 'chat.use') === true && can('guest', 'project.read') === false);

// ── Gateway route policy ──────────────────────────────────────────────
check('reading projects needs project.read',  requiredPermission('projects', 'GET') === 'project.read');
check('writing projects needs config.edit',    requiredPermission('projects', 'PATCH') === 'config.edit');
check('customer chat needs no permission',     requiredPermission('commerce', 'POST') === null);
check('unknown domain → undefined (caller denies)', requiredPermission('secrets', 'GET') === undefined);

if (failures) { console.error(`\n${failures} isolation/RBAC check(s) FAILED`); process.exit(1); }
console.log('\nAll tenant-isolation + RBAC checks passed.');
