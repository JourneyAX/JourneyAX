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
 * Explicit ADMIN_EMAIL / ADMIN_PASSWORD credentials are required.
 * We insert directly (bypassing the /register endpoint) because register
 * enforces an 8-char minimum and can only ever create a plain customer — the
 * local development/test may explicitly opt into ALLOW_INSECURE_DEV_ADMIN.
 * The planning and the write live in
 * admin-seed.ts so a test can rehearse them.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in root .env');

  const plan = planAdminSeed(process.env);

  const { db } = await connectToDatabase(uri, 'journeyx');
  await applyAdminSeed(db, plan, (password) => bcrypt.hash(password, 12));

  console.log(`✅ Admin seeded → email="${plan.email}" tenant="${plan.tenantId}" role=admin`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ seed-admin failed:', e);
  process.exit(1);
});
