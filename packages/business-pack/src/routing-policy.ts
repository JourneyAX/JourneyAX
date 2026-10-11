import type { RoutingPolicy } from './schemas/business-pack.schema';

/**
 * Minimal journey shape needed to select a default. Deliberately structural so Studio-compiled
 * journeys and schema-parsed journeys can both be passed in.
 */
export interface DefaultJourneyCandidate {
  journeyId: string;
  isDefaultConsultant?: boolean;
  metadata?: Record<string, unknown> | null;
}

export class RoutingPolicyResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoutingPolicyResolutionError';
  }
}

function isMarkedDefault(journey: DefaultJourneyCandidate): boolean {
  return journey.isDefaultConsultant === true || journey.metadata?.isDefaultConsultant === true;
}

/**
 * Resolves the routing policy to publish. Selection is explicit or unambiguous, never guessed:
 *  1. A configured `defaultJourneyId` wins, and must exist among the journeys (else error).
 *  2. Otherwise exactly one journey explicitly marked as default is selected
 *     (more than one marked journey is ambiguous and rejected).
 *  3. Otherwise, if exactly one journey exists, it is selected.
 *  4. Otherwise publication fails: positional ([0]) and tenant-derived IDs are forbidden.
 *
 * Any other configured routingPolicy fields (e.g. fallbackOnCatalogSearch) are preserved; when
 * absent, `fallbackOnCatalogSearch` is written explicitly as `true` so the published value is
 * never implicit.
 */
export function resolvePublicationRoutingPolicy(input: {
  configured?: RoutingPolicy | null;
  journeys: ReadonlyArray<DefaultJourneyCandidate>;
}): RoutingPolicy {
  const { configured, journeys } = input;
  const ids = journeys.map((j) => j.journeyId);
  const fallbackOnCatalogSearch = configured?.fallbackOnCatalogSearch ?? true;

  const configuredId = configured?.defaultJourneyId;
  if (configuredId) {
    if (!ids.includes(configuredId)) {
      throw new RoutingPolicyResolutionError(
        `Configured routingPolicy.defaultJourneyId '${configuredId}' does not match any journey. Available journeys: [${ids.join(', ')}]`
      );
    }
    return { ...configured, defaultJourneyId: configuredId, fallbackOnCatalogSearch };
  }

  const marked = journeys.filter(isMarkedDefault);
  if (marked.length === 1) {
    return { ...configured, defaultJourneyId: marked[0].journeyId, fallbackOnCatalogSearch };
  }
  if (marked.length > 1) {
    throw new RoutingPolicyResolutionError(
      `Ambiguous default journey: multiple journeys are marked as default [${marked.map((j) => j.journeyId).join(', ')}]. Configure routingPolicy.defaultJourneyId explicitly.`
    );
  }

  if (journeys.length === 1) {
    const [onlyJourney] = journeys;
    return { ...configured, defaultJourneyId: onlyJourney.journeyId, fallbackOnCatalogSearch };
  }

  if (journeys.length === 0) {
    throw new RoutingPolicyResolutionError('Cannot determine a default journey: the pack has no journeys.');
  }
  throw new RoutingPolicyResolutionError(
    `Cannot determine a default journey: ${journeys.length} journeys exist [${ids.join(', ')}] but none is configured or marked as default. Configure routingPolicy.defaultJourneyId explicitly.`
  );
}

/**
 * Canonical publication-boundary guard (used by publishBusinessPack, so scripts and any other
 * client calling it directly are covered). Unlike resolvePublicationRoutingPolicy it does not
 * synthesize a policy: it only verifies that the pack being persisted already carries an
 * unambiguous routing decision.
 *
 * Rejected:
 *  - more than one journey marked as default (even if a policy is configured: conflicting markers)
 *  - a configured routingPolicy.defaultJourneyId that does not reference a journey in the pack
 *  - several journeys with no configured default (a lone marker must already be persisted as the
 *    explicit routingPolicy.defaultJourneyId; positional/implicit selection is forbidden)
 *
 * Accepted:
 *  - exactly one journey
 *  - a valid explicit routingPolicy.defaultJourneyId
 */
export function assertPublishableRoutingPolicy(pack: {
  routingPolicy?: { defaultJourneyId?: string | null } | null;
  journeys: ReadonlyArray<DefaultJourneyCandidate>;
}): void {
  const journeys = pack.journeys ?? [];
  const ids = journeys.map((j) => j.journeyId);

  const marked = journeys.filter(isMarkedDefault);
  if (marked.length > 1) {
    throw new RoutingPolicyResolutionError(
      `Ambiguous default journey: multiple journeys are marked as default [${marked.map((j) => j.journeyId).join(', ')}]. Configure a single routingPolicy.defaultJourneyId.`
    );
  }

  const configuredId = pack.routingPolicy?.defaultJourneyId;
  if (configuredId) {
    if (!ids.includes(configuredId)) {
      throw new RoutingPolicyResolutionError(
        `Configured routingPolicy.defaultJourneyId '${configuredId}' does not match any journey. Available journeys: [${ids.join(', ')}]`
      );
    }
    return;
  }

  if (journeys.length === 1) return;

  throw new RoutingPolicyResolutionError(
    journeys.length === 0
      ? 'Cannot publish: the pack has no journeys.'
      : `Cannot publish: ${journeys.length} journeys exist [${ids.join(', ')}] but routingPolicy.defaultJourneyId is not set${
          marked.length === 1 ? ` (journey '${marked[0].journeyId}' is only marked as default; persist it explicitly)` : ''
        }. Positional or implicit default selection is not allowed.`
  );
}
