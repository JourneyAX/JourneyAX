import { SampleConnectorServer } from './server';

/**
 * Starts the sample connector server.
 *   SAMPLE_CONNECTORS_PORT     port (default 4010)
 *   SAMPLE_CONNECTORS_API_KEY  bearer key every request must carry (the runtime's CONNECTOR_SECRET_* resolver supplies it)
 *   SAMPLE_CONNECTORS_TENANTS  comma-separated tenants to hold data for (default: the tenant the seeds were built for)
 */
async function main() {
  const apiKey = process.env.SAMPLE_CONNECTORS_API_KEY || undefined;
  if (!apiKey && process.env.NODE_ENV === 'production') throw new Error('SAMPLE_CONNECTORS_API_KEY is required in production');
  const tenants = (process.env.SAMPLE_CONNECTORS_TENANTS || '').split(',').map((entry) => entry.trim()).filter(Boolean);
  const server = new SampleConnectorServer({ apiKey, ...(tenants.length > 0 ? { tenants } : {}) });
  const port = Number(process.env.SAMPLE_CONNECTORS_PORT || 4010);
  const base = await server.listen(port);
  console.log(`Sample connectors on ${base}/mcp/<connector>  (${server.connectorIds().join(', ')})`);
  if (!apiKey) console.log('No API key set: any caller may use this server. Fine on a laptop; set SAMPLE_CONNECTORS_API_KEY anywhere else.');
  const stop = () => { server.close().finally(() => process.exit(0)); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((err) => { console.error(err.message || err); process.exit(1); });
