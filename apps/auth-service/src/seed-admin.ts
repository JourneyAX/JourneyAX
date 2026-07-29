import 'reflect-metadata';
import { resolve } from 'path';
import { config } from 'dotenv';

// Load env vars from monorepo root .env (same as main.ts)
config({ path: resolve(__dirname, '../../../.env') });

import { connectToDatabase } from '@journeyax/database';
import * as bcrypt from 'bcrypt';

/**
 * Seed the platform super-admin used to sign in to the Back-Office console.
 *
 * Credentials (dev): admin / admin
 * We insert directly (bypassing the /register endpoint) because register
 * enforces an 8-char minimum — the login path has no such check, so a short
 * dev password is fine here. Override via ADMIN_EMAIL / ADMIN_PASSWORD.
 */
async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI not set in root .env');

  const email = (process.env.ADMIN_EMAIL || 'admin').toLowerCase();
  const password = process.env.ADMIN_PASSWORD || 'admin';
  const tenantId = (process.env.ADMIN_TENANT || 'platform').toLowerCase();

  const { db } = await connectToDatabase(uri, 'journeyx');
  const users = db.collection('users');

  const passwordHash = await bcrypt.hash(password, 12);

  await users.updateOne(
    { email },
    {
      $set: {
        email,
        passwordHash,
        tenantId,
        role: 'admin',
        fullName: 'Platform Admin',
        isActive: true,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );

  console.log(`✅ Admin seeded → email="${email}" password="${password}" tenant="${tenantId}" role=admin`);
  process.exit(0);
}

main().catch((e) => {
  console.error('❌ seed-admin failed:', e);
  process.exit(1);
});
