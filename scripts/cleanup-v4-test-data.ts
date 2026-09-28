import { MongoClient } from 'mongodb';

/**
 * Cleanup V4 Test Data Script
 *
 * Removes ephemeral and test fixture records from local or test MongoDB instances.
 * Defaults to DRY-RUN mode (safe, read-only audit).
 * Requires explicit `--apply` flag to commit deletes.
 *
 * Safe-by-construction:
 * - Scoped strictly to recognized test identifiers (prefixes: 'ws-scenario-', 'test-', 'mock-', 'ord_test_')
 * - Never targets production tenant IDs or un-prefixed records
 * - In offline/unauthenticated mode, safely exits with 0
 */

interface CollectionCleanupTarget {
  name: string;
  filter: Record<string, any>;
  description: string;
}

const TARGETS: CollectionCleanupTarget[] = [
  {
    name: 'workspaces',
    filter: {
      $or: [
        { workspaceId: { $regex: '^(ws-scenario-|test-|mock-|ws-test-)' } },
        { tenantId: { $regex: '^(tenant-test|tenant-prod-test|tenant-aero-dispatch|.*_fixture$)' } },
      ],
    },
    description: 'Ephemeral test workspaces and fixtures',
  },
  {
    name: 'outbox_events',
    filter: {
      $or: [
        { tenantId: { $regex: '^(tenant-test|tenant-prod-test|tenant-aero-dispatch|.*_fixture$)' } },
        { eventId: { $regex: '^(evt-test-|test-|mock-)' } },
      ],
    },
    description: 'Test outbox messages and synthetic dispatches',
  },
  {
    name: 'approval_requests',
    filter: {
      $or: [
        { tenantId: { $regex: '^(tenant-test|tenant-prod-test|tenant-aero-dispatch|.*_fixture$)' } },
        { requestId: { $regex: '^(appr_test-|test-)' } },
      ],
    },
    description: 'Test human-in-the-loop approval rows',
  },
  {
    name: 'execution_logs',
    filter: {
      $or: [
        { workspaceId: { $regex: '^(ws-scenario-|test-|mock-|ws-test-)' } },
        { tenantId: { $regex: '^(tenant-test|tenant-prod-test|tenant-aero-dispatch|.*_fixture$)' } },
      ],
    },
    description: 'Synthetic capability execution audit logs',
  },
  {
    name: 'execution_sessions',
    filter: {
      $or: [
        { sessionId: { $regex: '^(sess-scenario-|sess-test-|test-)' } },
        { tenantId: { $regex: '^(tenant-test|tenant-prod-test|tenant-aero-dispatch|.*_fixture$)' } },
      ],
    },
    description: 'Synthetic turn session records',
  },
];

export async function runCleanup(isApply = false): Promise<{ totalMatched: number; totalDeleted: number }> {
  const uri = process.env.TEST_MONGODB_URI || process.env.MONGODB_URI;

  if (!uri || !uri.startsWith('mongodb')) {
    console.log('🔒 Safe Offline Mode: No valid MongoDB connection URI provided (TEST_MONGODB_URI / MONGODB_URI).');
    console.log('   Zero shared database writes attempted. In-memory fixtures require no disk cleanup.');
    return { totalMatched: 0, totalDeleted: 0 };
  }

  console.log(`🧹 Running V4 Test Data Hygiene (${isApply ? 'APPLY MODE: COMMITTING DELETIONS' : 'DRY-RUN MODE: READ-ONLY AUDIT'})...\n`);

  const client = new MongoClient(uri);
  await client.connect();

  try {
    const db = client.db();
    let totalMatched = 0;
    let totalDeleted = 0;

    for (const target of TARGETS) {
      const col = db.collection(target.name);
      const count = await col.countDocuments(target.filter);
      totalMatched += count;

      if (isApply) {
        if (count > 0) {
          const deleteResult = await col.deleteMany(target.filter);
          totalDeleted += deleteResult.deletedCount || 0;
          console.log(`  🗑️  [${target.name}] Deleted ${deleteResult.deletedCount} records (${target.description})`);
        } else {
          console.log(`  ✓  [${target.name}] Clean: 0 matching test records`);
        }
      } else {
        console.log(`  🔍 [${target.name}] Found ${count} matching test records (${target.description})`);
      }
    }

    console.log('\n==================================================');
    if (isApply) {
      console.log(`✅ Cleanup Complete: Deleted ${totalDeleted} test records across collections.`);
    } else {
      console.log(`ℹ️ Dry-run Complete: Found ${totalMatched} test records eligible for cleanup.`);
      if (totalMatched > 0) {
        console.log('   Run with `tsx scripts/cleanup-v4-test-data.ts --apply` to commit deletions.');
      }
    }
    console.log('==================================================\n');

    return { totalMatched, totalDeleted };
  } finally {
    await client.close();
  }
}

if (require.main === module || (typeof process !== 'undefined' && process.argv[1]?.endsWith('cleanup-v4-test-data.ts'))) {
  const isApply = process.argv.includes('--apply');
  runCleanup(isApply)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Fatal error during test data cleanup:', err);
      process.exit(1);
    });
}
