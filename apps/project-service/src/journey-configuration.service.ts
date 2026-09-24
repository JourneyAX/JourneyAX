import { Injectable } from '@nestjs/common';
import { compileGraphToJourneyDefinition } from '@journeyax/business-pack';

export interface JourneyValidationResult {
  valid: boolean;
  errors: string[];
  compiledJourney?: any;
}

@Injectable()
export class JourneyConfigurationService {
  /**
   * Validates and compiles a visual journey graph into a strict typed JourneyDefinition.
   */
  validateAndCompileGraph(
    projectId: string,
    displayName: string,
    journeyGraph: { nodes?: any[]; edges?: any[] }
  ): JourneyValidationResult {
    if (!journeyGraph || !Array.isArray(journeyGraph.nodes) || journeyGraph.nodes.length === 0) {
      return {
        valid: false,
        errors: ['Journey graph must contain at least one node.'],
      };
    }

    const hasTrigger = journeyGraph.nodes.some((n: any) => n.data?.kind?.startsWith('trigger.'));
    if (!hasTrigger) {
      return {
        valid: false,
        errors: ['Journey graph must contain at least one Trigger node.'],
      };
    }

    const compileRes = compileGraphToJourneyDefinition(
      journeyGraph.nodes,
      journeyGraph.edges || [],
      {
        journeyId: projectId,
        displayName: displayName || projectId,
      }
    );

    if (!compileRes.success) {
      return {
        valid: false,
        errors: compileRes.errors || ['Compilation failed'],
      };
    }

    return {
      valid: true,
      errors: [],
      compiledJourney: compileRes.journeyDefinition,
    };
  }
}
