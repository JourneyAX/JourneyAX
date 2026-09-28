/**
 * offline-credential-isolation.ts
 *
 * Enterprise Offline Credential Isolation Guard & Localhost Egress Barrier
 *
 * Mandate:
 * 1. Unconditionally strips all database, cloud, external provider, cache, message broker,
 *    telemetry, and integration credentials/endpoints from process.env, preventing accidental
 *    network egress or credential leakage.
 * 2. Enforces a strict localhost/loopback-only network egress barrier across dns, net.Socket,
 *    http, https, and fetch. Any outbound attempt to a non-loopback host fails closed immediately.
 */


export const ISOLATED_CREDENTIAL_KEYS = [
  // Cache / Redis / Datastores
  'REDIS_URL',
  'REDIS_HOST',
  'REDIS_PORT',
  'REDIS_PASSWORD',
  'REDIS_TLS',
  'REDIS_USER',
  'AP_REDIS_HOST',
  'AP_REDIS_PORT',
  'CACHE_URL',
  'MEMCACHED_SERVERS',
  'VALKEY_URL',

  // Brokers, Event Buses & Streaming
  'KAFKA_BROKERS',
  'KAFKA_URL',
  'KAFKA_CLIENT_ID',
  'KAFKA_GROUP_ID',
  'RABBITMQ_URL',
  'AMQP_URL',
  'PUBSUB_EMULATOR_HOST',
  'EVENTARC_URL',
  'NATS_URL',
  'BROKER_URL',
  'SQS_QUEUE_URL',
  'SNS_TOPIC_ARN',

  // Telemetry, APM, Tracing & Metrics
  'OTEL_EXPORTER_OTLP_ENDPOINT',
  'OTEL_EXPORTER_OTLP_TRACES_ENDPOINT',
  'OTEL_EXPORTER_OTLP_METRICS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT',
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_JAEGER_ENDPOINT',
  'OTEL_EXPORTER_ZIPKIN_ENDPOINT',
  'OTEL_SERVICE_NAME',
  'DATADOG_API_KEY',
  'DD_API_KEY',
  'DD_AGENT_HOST',
  'DD_TRACE_AGENT_URL',
  'DD_DOGSTATSD_PORT',
  'SENTRY_DSN',
  'STATSD_HOST',
  'STATSD_PORT',
  'TELEMETRY_ENDPOINT',
  'TELEMETRY_URL',
  'NEW_RELIC_LICENSE_KEY',
  'HONEYCOMB_API_KEY',
  'LOGSTASH_HOST',
  'PROMETHEUS_GATEWAY_URL',

  // Database URIs
  'MONGODB_URI',
  'TEST_MONGODB_URI',
  'MONGODB_DEV_URI',
  'MONGODB_QA_URI',
  'DATABASE_URL',
  'POSTGRES_URL',
  'MYSQL_URL',
  'COCKROACH_URL',
  'PRISMA_DATABASE_URL',

  // AI & LLM Provider API Keys & Base URLs
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'GOOGLE_API_BASE_URL',
  'PERPLEXITY_API_KEY',
  'REPLICATE_API_TOKEN',
  'LLM_MODEL',
  'PLACEMAKER_MODEL_URL',
  'PLACEMAKER_MODEL_TOKEN',
  'JAX_PLACEMAKERS_MODEL_URL',
  'FABRIC_DIFFUSION_DEPLOYMENT',
  'FABRIC_DIFFUSION_VERSION',
  'RETEXTURE_SERVICE_URL',
  'CDL_PROOF_MODEL',
  'CDL_VISION_MODEL',
  'CDL_VISION_MODEL_OPENAI',
  'INGEST_MODEL',
  'INTENT_MODEL',
  'TEAM_COLOUR_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_API_KEY',
  'CUSTOM_MODEL_ENDPOINT',
  'OPEN_MODEL_ENDPOINT',

  // Connectors, Integrations & Webhooks
  'ACTIVEPIECES_API_KEY',
  'ACTIVEPIECES_API_URL',
  'ACTIVEPIECES_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'COMMERCETOOLS_CLIENT_SECRET',
  'COMMERCETOOLS_CLIENT_ID',
  'SHOPIFY_API_KEY',
  'SHOPIFY_API_SECRET',
  'HUBSPOT_ACCESS_TOKEN',
  'JIRA_API_TOKEN',
  'SENDGRID_API_KEY',
  'WHATSAPP_APP_SECRET',
  'WHATSAPP_VERIFY_TOKEN',

  // Cloud Secrets & IAM
  'GOOGLE_APPLICATION_CREDENTIALS',
  'GCP_ID_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'INTERNAL_API_KEY',
  'INTERNAL_SERVICE_KEY',
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'GATEWAY_ASSERTION_SECRET',
] as const;

export interface EgressViolation {
  timestamp: string;
  operation: string;
  target: string;
  stack?: string;
}

const recordedViolations: EgressViolation[] = [];

/**
 * Returns a read-only list of all recorded outbound non-loopback egress attempts.
 */
export function getEgressViolations(): readonly EgressViolation[] {
  return [...recordedViolations];
}

/**
 * Clears recorded egress violations.
 */
export function resetEgressViolations(): void {
  recordedViolations.length = 0;
}

/**
 * Determines whether the specified host is a loopback address or localhost.
 */
export function isLoopbackHost(host?: string | null): boolean {
  if (!host) return true;
  const h = host.toLowerCase().trim();
  // Strip IPv6 brackets if present e.g. [::1] -> ::1
  const unbracketed = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
  if (
    unbracketed === 'localhost' ||
    unbracketed === '127.0.0.1' ||
    unbracketed === '::1' ||
    unbracketed === '0.0.0.0' ||
    unbracketed === '::' ||
    unbracketed.endsWith('.localhost')
  ) {
    return true;
  }
  // IPv4 127.0.0.0/8 loopback range
  if (/^127(?:\.(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)){3}$/.test(unbracketed)) {
    return true;
  }
  return false;
}

function recordViolation(operation: string, target: string): Error {
  const err = new Error(
    `[OfflineCredentialIsolation] Localhost-only egress violation: Blocked non-loopback network attempt "${operation}" to "${target}". Only localhost/loopback egress is permitted in isolated canary.`
  );
  recordedViolations.push({
    timestamp: new Date().toISOString(),
    operation,
    target,
    stack: err.stack,
  });
  return err;
}

let dnsGuarded = false;
let netGuarded = false;
let httpGuarded = false;
let fetchGuarded = false;

function patchDns(): void {
  if (dnsGuarded) return;
  dnsGuarded = true;

  // Use require() so we get the mutable CJS module object — ESM namespace
  // proxies created by ts-node make properties getter-only and unassignable.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const dns = require('node:dns') as typeof import('node:dns');

  const originalLookup = dns.lookup;
  dns.lookup = function (hostname: any, options: any, callback: any) {
    let cb = typeof options === 'function' ? options : callback;
    const hostStr = String(hostname || '');
    if (hostStr && !isLoopbackHost(hostStr)) {
      const err = recordViolation('dns.lookup', hostStr);
      if (typeof cb === 'function') {
        process.nextTick(() => cb(err));
      }
      throw err;
    }
    return originalLookup.apply(this, arguments as any);
  } as any;

  if (dns.promises) {
    const origPromiseLookup = dns.promises.lookup;
    dns.promises.lookup = async function (hostname: any, options?: any) {
      const hostStr = String(hostname || '');
      if (hostStr && !isLoopbackHost(hostStr)) {
        const err = recordViolation('dns.promises.lookup', hostStr);
        throw err;
      }
      return origPromiseLookup.apply(this, arguments as any);
    };

    for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveAny'] as const) {
      if (typeof (dns.promises as any)[method] === 'function') {
        const orig = (dns.promises as any)[method];
        (dns.promises as any)[method] = async function (hostname: any, ...args: any[]) {
          const hostStr = String(hostname || '');
          if (hostStr && !isLoopbackHost(hostStr)) {
            const err = recordViolation(`dns.promises.${method}`, hostStr);
            throw err;
          }
          return orig.apply(this, [hostname, ...args]);
        };
      }
    }
  }

  for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveCname', 'resolveMx', 'resolveNs', 'resolveTxt', 'resolveSrv', 'resolveAny'] as const) {
    if (typeof (dns as any)[method] === 'function') {
      const orig = (dns as any)[method];
      (dns as any)[method] = function (hostname: any, ...args: any[]) {
        const hostStr = String(hostname || '');
        const cb = args[args.length - 1];
        if (hostStr && !isLoopbackHost(hostStr)) {
          const err = recordViolation(`dns.${method}`, hostStr);
          if (typeof cb === 'function') {
            process.nextTick(() => cb(err));
          }
          throw err;
        }
        return orig.apply(this, [hostname, ...args]);
      };
    }
  }
}

function patchNet(): void {
  if (netGuarded) return;
  netGuarded = true;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const net = require('node:net') as typeof import('node:net');

  const originalConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: net.Socket, ...args: any[]) {
    let destHost: string | undefined;
    const first = args[0];
    if (typeof first === 'object' && first !== null) {
      if (first.path) {
        // Unix domain socket / named pipe - loopback IPC permitted
        destHost = undefined;
      } else {
        destHost = first.host || first.hostname;
      }
    } else if (typeof first === 'string' && isNaN(Number(first))) {
      // IPC pipe path
      destHost = undefined;
    } else if (typeof first === 'number') {
      if (typeof args[1] === 'string') {
        destHost = args[1];
      }
    }

    if (destHost && !isLoopbackHost(destHost)) {
      const err = recordViolation('net.Socket.connect', destHost);
      this.destroy(err);
      throw err;
    }

    return originalConnect.apply(this, args as any);
  };
}

function extractHostFromRequestArgs(args: any[]): string | undefined {
  const first = args[0];
  if (typeof first === 'string') {
    try {
      const u = new URL(first, 'http://localhost');
      return u.hostname;
    } catch {
      return undefined;
    }
  }
  if (first instanceof URL) {
    return first.hostname;
  }
  if (typeof first === 'object' && first !== null) {
    return first.hostname || first.host;
  }
  return undefined;
}

function patchHttp(): void {
  if (httpGuarded) return;
  httpGuarded = true;

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('node:http') as typeof import('node:http');
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const https = require('node:https') as typeof import('node:https');

  const originalHttpRequest = http.request;
  http.request = function (...args: any[]) {
    const host = extractHostFromRequestArgs(args);
    if (host && !isLoopbackHost(host)) {
      const err = recordViolation('http.request', host);
      throw err;
    }
    return originalHttpRequest.apply(this, args as any);
  } as any;

  const originalHttpsRequest = https.request;
  https.request = function (...args: any[]) {
    const host = extractHostFromRequestArgs(args);
    if (host && !isLoopbackHost(host)) {
      const err = recordViolation('https.request', host);
      throw err;
    }
    return originalHttpsRequest.apply(this, args as any);
  } as any;
}

function patchFetch(): void {
  if (fetchGuarded) return;
  fetchGuarded = true;

  const origFetch = globalThis.fetch;
  if (typeof origFetch === 'function') {
    globalThis.fetch = async function (input: any, init?: any) {
      let host: string | undefined;
      if (typeof input === 'string') {
        try {
          host = new URL(input, 'http://localhost').hostname;
        } catch {}
      } else if (input instanceof URL) {
        host = input.hostname;
      } else if (input && typeof input.url === 'string') {
        try {
          host = new URL(input.url, 'http://localhost').hostname;
        } catch {}
      }

      if (host && !isLoopbackHost(host)) {
        const err = recordViolation('fetch', host);
        throw err;
      }
      return origFetch(input, init);
    };
  }
}

/**
 * Installs the localhost-only egress barrier across node network libraries.
 */
export function installLocalhostEgressGuard(): void {
  patchDns();
  patchNet();
  patchHttp();
  patchFetch();
}

/**
 * Asserts that zero non-loopback network calls were attempted.
 * Fails closed if any egress violation was recorded.
 */
export function assertLocalhostOnlyEgress(): void {
  const violations = getEgressViolations();
  if (violations.length > 0) {
    const details = violations.map((v) => `${v.operation}(${v.target})`).join(', ');
    throw new Error(
      `[OfflineCredentialIsolation] Localhost-only egress assertion failed: ${violations.length} non-loopback network attempt(s) detected: ${details}`
    );
  }
}

/**
 * Strips all sensitive credentials, brokers, endpoints, and cache URLs from process.env
 * and sets the offline harness flag.
 */
export function enforceOfflineCredentialIsolation(): void {
  process.env.JOURNEYAX_OFFLINE_HARNESS = 'true';
  for (const key of ISOLATED_CREDENTIAL_KEYS) {
    delete process.env[key];
  }
}

/**
 * Asserts that no sensitive credentials, broker endpoints, or provider keys exist in process.env.
 */
export function assertOfflineCredentialIsolation(): void {
  if (process.env.JOURNEYAX_OFFLINE_HARNESS !== 'true') {
    throw new Error(
      '[OfflineCredentialIsolation] Security violation: JOURNEYAX_OFFLINE_HARNESS must be set to "true".'
    );
  }
  const violations: string[] = [];
  for (const key of ISOLATED_CREDENTIAL_KEYS) {
    if (process.env[key] !== undefined && process.env[key] !== '') {
      violations.push(key);
    }
  }
  if (violations.length > 0) {
    throw new Error(
      `[OfflineCredentialIsolation] Security violation: Found active credentials in process.env: [${violations.join(', ')}]. Offline test harnesses must be strictly isolated.`
    );
  }
}

// Automatically enforce credential isolation and install localhost egress barrier upon import
enforceOfflineCredentialIsolation();
installLocalhostEgressGuard();
