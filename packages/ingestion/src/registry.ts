/**
 * SourceConnectorRegistry — mirrors AdapterRegistry in packages/integration.
 *
 * The pipeline resolves connectors by source `type` through this registry, so it
 * never imports a concrete connector. Registering a new source type is one call;
 * onboarding a tenant that uses it is pure configuration.
 */
import { IngestionSourcePort, SourceConfig, IngestionContext, IngestionResult } from './ports';

export class SourceConnectorRegistry {
  private readonly connectors = new Map<string, IngestionSourcePort>();

  register(connector: IngestionSourcePort): this {
    this.connectors.set(connector.type, connector);
    return this;
  }

  get(type: string): IngestionSourcePort | undefined {
    return this.connectors.get(type);
  }

  /** Source types this deployment can ingest — drives the back-office picker. */
  supportedTypes(): { type: string; label: string }[] {
    return [...this.connectors.values()].map((c) => ({ type: c.type, label: c.label }));
  }

  /** Validate a project's configured sources before running anything. */
  validateAll(sources: SourceConfig[]): { ok: boolean; issues: string[] } {
    const issues: string[] = [];
    for (const s of sources) {
      if (s.enabled === false) continue;
      const c = this.connectors.get(s.type);
      if (!c) { issues.push(`${s.id}: unsupported source type "${s.type}"`); continue; }
      const v = c.validate?.(s);
      if (v && !v.ok) issues.push(`${s.id}: ${v.message || 'invalid configuration'}`);
    }
    return { ok: issues.length === 0, issues };
  }

  /**
   * Run every enabled source, grouped by type so a connector receives all of its
   * sources at once (a CSV connector needs US+CAD+inventory together to build one
   * coherent catalogue).
   */
  async runAll(sources: SourceConfig[], ctx: IngestionContext, only?: string[]): Promise<IngestionResult[]> {
    const enabled = sources.filter((s) => s.enabled !== false && (!only?.length || only.includes(s.type)));
    const byType = new Map<string, SourceConfig[]>();
    for (const s of enabled) {
      if (!byType.has(s.type)) byType.set(s.type, []);
      byType.get(s.type)!.push(s);
    }

    const results: IngestionResult[] = [];
    for (const [type, group] of byType) {
      const connector = this.connectors.get(type);
      if (!connector) {
        await ctx.log(`skip: no connector registered for "${type}"`);
        results.push({ sourceId: type, errors: [`no connector for type "${type}"`] });
        continue;
      }
      await ctx.log(`→ ${connector.label} (${group.length} source(s))`);
      try {
        results.push(...(await connector.ingest(group, ctx)));
      } catch (e) {
        results.push({ sourceId: type, errors: [(e as Error).message] });
        await ctx.log(`✗ ${connector.label}: ${(e as Error).message}`);
      }
    }
    return results;
  }
}
