import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env (same as main.ts)
config({ path: resolve(__dirname, '../../../.env') });

import { connectToDatabase } from '@journeyax/database';
import * as bcrypt from 'bcrypt';
import { applyAdminSeed, planAdminSeed } from './admin-seed';

/**
 * Seed the platform super-admin used to sign in to the Back-Office console.
 *
 * Credentials (dev): admin / admin
 * We insert directly (bypassing the /register endpoint) because register
 * enforces an 8-char minimum and can only ever create a plain customer — the
 * login path has no such check, so a short dev password is fine here.
 * Override via ADMIN_EMAIL / ADMIN_PASSWORD. The planning and the write live in
 * admin-seed.ts so a test can rehearse them.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in root .env');

  const plan = planAdminSeed(process.env);

  const { db } = await connectToDatabase(uri, 'journeyx');
  await applyAdminSeed(db, plan, (password) => bcrypt.hash(password, 12));

  console.log(`✅ Admin seeded → email="${plan.email}" password="${plan.password}" tenant="${plan.tenantId}" role=admin`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ seed-admin failed:', e);
  process.exit(1);
});
