import * as dotenv from 'dotenv';
import * as path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../.env') });
import { connectToDatabase, ensureDatabaseIndices } from '@journeyax/database';

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('Missing MONGODB_URI');
    process.exit(1);
  }

  const dbName = process.env.MONGODB_DB_NAME || 'journeyx';
  console.log(`Connecting to MongoDB (${dbName})...`);
  const { db, client } = await connectToDatabase(uri, dbName);

  console.log('Ensuring all canonical database indices...');
  await ensureDatabaseIndices(db);
  console.log('✅ Canonical database indices successfully applied:');
  console.log(' - business_pack_releases: uniq_tenant_env_version, idx_tenant_env_published');
  console.log(' - business_pack_pointers: uniq_tenant_env_pointer');
  console.log(' - customer_workspaces: uniq_tenant_env_workspace, idx_tenant_env_updated');
  console.log(' - tool_approvals: uniq_tenant_env_approval, ttl_approval_expiration');
  console.log(' - tool_executions: uniq_tenant_env_tool_idempotency, ttl_execution_expiration');
  console.log(' - outbox_events: idx_outbox_status_created, idx_outbox_tenant_env_type');
  console.log(' - products: idx_products_project_safety_toe, idx_products_project_category');

  await client.close();
}

run().catch((err) => {
  console.error('Failed to ensure database indices:', err);
  process.exit(1);
});
