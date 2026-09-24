/**
 * Guard script for integration tests requiring live MongoDB.
 * Strictly enforces that TEST_MONGODB_URI is provided, DB name contains 'test',
 * and rejects missing URI or DB name without test.
 * Never allows falling back to MONGODB_URI or localhost.
 */

// Explicitly ensure MONGODB_URI is never used as fallback
if (process.env.MONGODB_URI) {
  delete process.env.MONGODB_URI;
}

const uri = process.env.TEST_MONGODB_URI?.trim();
if (!uri) {
  console.error('❌ Guard Error: TEST_MONGODB_URI environment variable is required to run integration tests.');
  console.error('   Fallback to MONGODB_URI or localhost is strictly prohibited.');
  process.exit(1);
}

let dbName = process.env.TEST_MONGODB_DB_NAME?.trim();
if (!dbName) {
  try {
    const parsed = new URL(uri);
    const pathPart = parsed.pathname.replace(/^\//, '').trim();
    if (pathPart) {
      dbName = pathPart;
    }
  } catch {}
}

if (!dbName) {
  dbName = 'journeyx_phase1_test';
}

if (!dbName.toLowerCase().includes('test')) {
  console.error(`❌ Guard Error: Database name "${dbName}" rejected. Database name must contain "test".`);
  process.exit(1);
}
