import { validateSecretReference } from '@journeyax/business-pack';

/** Turns a secret reference into the secret, at the last moment. The platform stores and passes references only. */
export interface SecretResolver {
  resolve(secretRef: string, scope: { tenantId: string; environmentId: string }): Promise<string>;
}

/**
 * Development resolver: the last part of the reference names an environment variable, `CONNECTOR_SECRET_<NAME>` (upper case, other
 * characters become `_`). A production deployment supplies its own resolver backed by the secret manager.
 */
export class EnvSecretResolver implements SecretResolver {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async resolve(secretRef: string): Promise<string> {
    const name = secretRef.split('/').filter(Boolean).pop() || '';
    const variable = `CONNECTOR_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
    const value = this.env[variable];
    if (!value) throw new Error(`The secret '${name}' is not configured`);
    return value;
  }
}

/** A reference is accepted only if it is a reference and belongs to this tenant and environment. Throws a message without the reference's content otherwise. */
export function assertSecretRefInScope(secretRef: string, scope: { tenantId: string; environmentId: string }): void {
  const issues = validateSecretReference(secretRef, scope.tenantId, scope.environmentId);
  if (issues.length > 0) throw new Error(`Secret reference refused (${issues.map((issue) => issue.code).join(', ')})`);
}

/** Collects the secret values a client has used, so anything that might echo one can be scrubbed before it goes anywhere. */
export class SecretLedger {
  private readonly values = new Set<string>();

  add(value: string): void {
    if (value && value.length >= 4) this.values.add(value);
  }

  redact = (text: string): string => {
    let out = text;
    for (const value of this.values) {
      for (const form of new Set([value, JSON.stringify(value).slice(1, -1), encodeURIComponent(value)])) {
        if (form) out = out.split(form).join('[redacted]');
      }
    }
    return out;
  };

  contains(text: string): boolean {
    return [...this.values].some((value) => text.includes(value));
  }
}
