import { createRealConnectors } from './index';
import { RealConnectorServer } from './server';

/**
 * Starts the real connector server.
 *   REAL_CONNECTORS_PORT     port (default 4020)
 *   REAL_CONNECTORS_API_KEY  bearer key every request must carry (the runtime's CONNECTOR_SECRET_* resolver supplies it); required in production
 *   REAL_CONNECTORS_TENANTS  comma-separated tenants this server may answer for (default: placemakers)
 * and the settings of each vendor (see the header of each file in src/connectors). Keep them in their own file and start the server with
 *   npx tsx --env-file=.env.connectors packages/connectors-real/src/cli.ts
 * so the vendors' credentials exist only in this process, never in the runtime, the gateway or the web app.
 */
async function main() {
  const apiKey = process.env.REAL_CONNECTORS_API_KEY || undefined;
  if (!apiKey && process.env.NODE_ENV === 'production') throw new Error('REAL_CONNECTORS_API_KEY is required in production');
  const tenants = (process.env.REAL_CONNECTORS_TENANTS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const server = new RealConnectorServer({ connectors: createRealConnectors(), apiKey, ...(tenants.length > 0 ? { tenants } : {}) });
  const port = Number(process.env.REAL_CONNECTORS_PORT || 4020);
  const base = await server.listen(port);
  console.log(`Real connectors on ${base}/mcp/<connector>`);
  for (const connector of server.health().connectors as Array<{ id: string; connected: boolean; missing?: string[] }>) {
    console.log(`  ${connector.connected ? 'connected    ' : 'not connected'}  ${connector.id}${connector.missing ? `   needs: ${connector.missing.join(', ')}` : ''}`);
  }
  if (!apiKey) console.log('No API key set: any caller may use this server. Fine on a laptop; set REAL_CONNECTORS_API_KEY anywhere else.');
  const stop = () => { server.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
