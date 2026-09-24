/**
 * ============================================================================
 * DEPRECATION NOTICE — EMBEDDED TURN RUNNER DECOMMISSIONED
 * ============================================================================
 * The embedded TurnRunner and filesystem Business Pack loader inside
 * agent-commerce-service have been decommissioned.
 *
 * All domain-neutral Business Pack executions must route exclusively to
 * canonical journey-runtime-service (apps/journey-runtime-service).
 * ============================================================================
 */

export class TurnRunner {
  constructor() {
    throw new Error(
      'TurnRunner in agent-commerce-service is decommissioned. Route requests through apps/journey-runtime-service.'
    );
  }

  hasPack(_tenantId: string): boolean {
    return false;
  }
}
