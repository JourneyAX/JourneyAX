/**
 * Where the MCP servers live. The pack names a server; this says where it is. Addresses are runtime configuration, so a pack is the same
 * in development, test and production.
 */
export interface McpServerDirectory {
  resolve(serverName: string): { url: string } | undefined;
}

export class StaticMcpServerDirectory implements McpServerDirectory {
  constructor(private readonly servers: Record<string, string>) {}
  resolve(serverName: string) {
    const url = this.servers[serverName];
    return url ? { url } : undefined;
  }
}

/**
 * `CONNECTOR_MCP_SERVERS`: a JSON object of server name to address, for servers that live apart.
 * `CONNECTOR_MCP_BASE_URL`: one base address; the server called `x` is then at `<base>/mcp/x`.
 */
export class EnvMcpServerDirectory implements McpServerDirectory {
  private readonly named: Record<string, string> = {};
  private readonly base: string;

  constructor(env: NodeJS.ProcessEnv = process.env) {
    try {
      const parsed = JSON.parse(env.CONNECTOR_MCP_SERVERS || '{}');
      if (parsed && typeof parsed === 'object') {
        for (const [name, url] of Object.entries(parsed)) if (typeof url === 'string') this.named[name] = url;
      }
    } catch {
      // An unreadable setting means no named servers; calls then fail with "not configured".
    }
    this.base = (env.CONNECTOR_MCP_BASE_URL || '').trim().replace(/\/+$/, '');
  }

  resolve(serverName: string) {
    if (this.named[serverName]) return { url: this.named[serverName] };
    return this.base ? { url: `${this.base}/mcp/${encodeURIComponent(serverName)}` } : undefined;
  }
}

const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[?::1\]?|.*\.local|.*\.internal)$/i;
const ALWAYS_REFUSED_HOST = /^(169\.254\.\d+\.\d+|metadata\.google\.internal|metadata|\[?fe80:.*)$/i;

/**
 * A server address must be a plain http(s) address without credentials. The cloud-metadata and link-local addresses are always refused.
 * In production the address must be https and must not be loopback or private.
 */
export function assertSafeMcpUrl(rawUrl: string, nodeEnv: string | undefined = process.env.NODE_ENV): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('The MCP server address is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('The MCP server address must be http or https');
  if (url.username || url.password) throw new Error('The MCP server address must not carry credentials');
  if (ALWAYS_REFUSED_HOST.test(url.hostname)) throw new Error('The MCP server address points at a link-local or metadata address');
  if ((nodeEnv || '').toLowerCase() === 'production') {
    if (url.protocol !== 'https:') throw new Error('In production the MCP server address must be https');
    if (PRIVATE_HOST.test(url.hostname)) throw new Error('In production the MCP server address must not be a private or loopback address');
  }
  return url;
}
