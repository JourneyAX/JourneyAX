/**
 * The platform super-admin login, planned and written apart from the script that runs it (`seed-admin.ts`) so a test can rehearse it
 * in memory. This is one of the two ways a staff or admin login comes to exist (the other is `scripts/placemakers/seed-demo-staff.ts`):
 * both write the user document directly, because the open registration route can only ever create a plain customer.
 */
export interface AdminSeedPlan {
  email: string;
  password: string;
  tenantId: string;
}

interface UsersDbLike {
  collection(name: string): { updateOne(filter: any, update: any, options?: any): Promise<any> };
}

/** Real seeds require explicit credentials. The insecure fixture is an opt-in for local development/test only. */
export function planAdminSeed(env: Record<string, string | undefined>): AdminSeedPlan {
  const localFixture = ['development', 'test'].includes(env.NODE_ENV || '') && env.ALLOW_INSECURE_DEV_ADMIN === 'true';
  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!localFixture && (!email || !password || password.length < 8 || password.trim().toLowerCase() === 'admin')) {
    throw new Error('Set ADMIN_EMAIL and an ADMIN_PASSWORD of at least eight characters. Default admin credentials are not permitted.');
  }
  return {
    email: (email || 'admin').toLowerCase(),
    password: password || 'admin',
    tenantId: (env.ADMIN_TENANT || 'platform').toLowerCase(),
  };
}

/** Writes the admin with an upsert, so running it twice changes nothing but the password hash. `hash` turns the password into the stored hash (bcrypt in the script). */
export async function applyAdminSeed(db: UsersDbLike, plan: AdminSeedPlan, hash: (password: string) => Promise<string>): Promise<void> {
  await db.collection('users').updateOne(
    { email: plan.email },
    {
      $set: {
        email: plan.email,
        passwordHash: await hash(plan.password),
        tenantId: plan.tenantId,
        role: 'admin',
        fullName: 'Platform Admin',
        isActive: true,
      },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}
