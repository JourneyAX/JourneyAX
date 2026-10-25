import { McpClient } from './client';
import { assertSafeMcpUrl, type McpServerDirectory } from './directory';
import { EnvSecretResolver, SecretLedger, assertSecretRefInScope, type SecretResolver } from './secrets';
import { HttpMcpTransport } from './transport';
import type { McpClientLimits, McpScope } from './types';

/** Gives the dispatcher a client for a named server, for one tenant and environment. */
export interface McpClientProvider {
  getClient(serverName: string, scope: McpScope): Promise<McpClient>;
}

export interface McpClientPoolOptions {
  directory: McpServerDirectory;
  secrets?: SecretResolver;
  limits?: Partial<McpClientLimits>;
  fetchImpl?: typeof fetch;
  nodeEnv?: string;
}

/**
 * One client per tenant, environment, server, connection and secret, so one tenant's session, tool list and secrets are never shared with
 * another. The secret is resolved from its reference for every request and never kept anywhere but a ledger that scrubs it from output.
 */
export class McpClientPool implements McpClientProvider {
  private readonly clients = new Map<string, McpClient>();
  private readonly secrets: SecretResolver;

  constructor(private readonly options: McpClientPoolOptions) {
    this.secrets = options.secrets ?? new EnvSecretResolver();
  }

  async getClient(serverName: string, scope: McpScope): Promise<McpClient> {
    if (!scope.tenantId || !scope.environmentId) throw new Error('An MCP client needs a tenant and an environment');
    const key = [scope.tenantId, scope.environmentId, serverName, scope.connectionRef ?? '', scope.secretRef ?? ''].join('|');
    const existing = this.clients.get(key);
    if (existing) return existing;

    const found = this.options.directory.resolve(serverName);
    if (!found) throw new Error(`The MCP server '${serverName}' is not configured`);
    const url = assertSafeMcpUrl(found.url, this.options.nodeEnv).toString();
    if (scope.secretRef) assertSecretRefInScope(scope.secretRef, scope);

    const ledger = new SecretLedger();
    const transport = new HttpMcpTransport({
      url,
      fetchImpl: this.options.fetchImpl,
      redact: ledger.redact,
      headers: async (): Promise<Record<string, string>> => {
        if (!scope.secretRef) return {};
        const secret = await this.secrets.resolve(scope.secretRef, { tenantId: scope.tenantId, environmentId: scope.environmentId });
        ledger.add(secret);
        return { Authorization: `Bearer ${secret}` };
      },
    });
    const client = new McpClient(transport, serverName, this.options.limits, ledger.redact);
    this.clients.set(key, client);
    return client;
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.clients.values()].map((client) => client.close()));
    this.clients.clear();
  }
}
