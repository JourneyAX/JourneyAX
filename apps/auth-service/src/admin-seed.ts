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

/** Credentials (dev): admin / admin in the `platform` tenant. Override with ADMIN_EMAIL / ADMIN_PASSWORD / ADMIN_TENANT. */
export function planAdminSeed(env: Record<string, string | undefined>): AdminSeedPlan {
  return {
    email: (env.ADMIN_EMAIL || 'admin').toLowerCase(),
    password: env.ADMIN_PASSWORD || 'admin',
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
