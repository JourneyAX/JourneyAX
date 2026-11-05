import { createRealConnectors } from './index';
import { RealConnectorServer } from './server';
import { MongoConnectionPool, MongoReplayStore, COLLECTION_GATEWAY_ASSERTION_NONCES } from '@journeyax/database';

/**
 * Starts the real connector server.
 *   REAL_CONNECTORS_PORT     port (default 4020)
 *   REAL_CONNECTORS_API_KEY  bearer key every request must carry (the runtime's CONNECTOR_SECRET_* resolver supplies it); required in production
 *   REAL_CONNECTORS_TENANTS  comma-separated tenants this server may answer for (required: one tenant per process)
 * and the settings of each vendor (see the header of each file in src/connectors). Keep them in their own file and start the server with
 *   npx tsx --env-file=.env.connectors packages/connectors-real/src/cli.ts
 * so the vendors' credentials exist only in this process, never in the runtime, the gateway or the web app.
 */
async function main() {
  const apiKey = process.env.REAL_CONNECTORS_API_KEY || undefined;
  if (!apiKey && process.env.NODE_ENV === 'production') throw new Error('REAL_CONNECTORS_API_KEY is required in production');
  const tenants = (process.env.REAL_CONNECTORS_TENANTS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const environmentId = process.env.REAL_CONNECTORS_ENVIRONMENT;
  const connectionRef = process.env.REAL_CONNECTORS_CONNECTION_REF;
  const iqScopeSecret = process.env.JAX_IQ_CONNECTOR_SIGNING_SECRET;
  const commandScopeSecret = process.env.JAX_COMMAND_SIGNING_SECRET;
  if (tenants.length !== 1 || !environmentId || !connectionRef || !apiKey || !iqScopeSecret || iqScopeSecret.length < 32) throw new Error('Each connector process requires one explicit tenant, environment, connection reference, API key and IQ signing secret.');
  const replayUri = process.env.REAL_CONNECTORS_REPLAY_MONGODB_URI;
  const replayDatabase = process.env.REAL_CONNECTORS_REPLAY_DATABASE;
  if ((replayUri && !replayDatabase) || (!replayUri && replayDatabase) || (process.env.NODE_ENV === 'production' && !replayUri)) throw new Error('An explicit shared source replay database is required; no vendor/runtime database fallback is used.');
  const pool = new MongoConnectionPool();
  let replayStore: MongoReplayStore | undefined;
  if (replayUri && replayDatabase) {
    const connection = await pool.connect(replayUri, replayDatabase);
    // A failed uniqueness index must stop startup, not silently weaken nonce claims.
    await connection.db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES).createIndex({ jti: 1 }, { unique: true });
    await connection.db.collection(COLLECTION_GATEWAY_ASSERTION_NONCES).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    replayStore = new MongoReplayStore(async () => connection);
  }
  const server = new RealConnectorServer({ connectors: createRealConnectors(), apiKey, tenants, environmentId, connectionRef, iqScopeSecret, commandScopeSecret, replayStore });
  const port = Number(process.env.REAL_CONNECTORS_PORT || process.env.PORT || 4020);
  const base = await server.listen(port, process.env.REAL_CONNECTORS_HOST || '127.0.0.1');
  console.log(`Real connectors on ${base}/mcp/<connector>`);
  for (const connector of server.health().connectors as Array<{ id: string; connected: boolean; missing?: string[] }>) {
    console.log(`  ${connector.connected ? 'connected    ' : 'not connected'}  ${connector.id}${connector.missing ? `   needs: ${connector.missing.join(', ')}` : ''}`);
  }
  if (!apiKey) console.log('No API key set: any caller may use this server. Fine on a laptop; set REAL_CONNECTORS_API_KEY anywhere else.');
  const stop = () => { server.close().finally(async () => { await pool.close(); process.exit(0); }); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
