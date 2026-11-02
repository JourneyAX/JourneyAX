import { Injectable, Inject } from '@nestjs/common';
import { JourneyCoordinator } from './orchestration/journey-coordinator';
import { ChatRequest, ChatResponse } from './pipeline/types';

export * from './pipeline/types';
export * from './orchestration/journey-coordinator';

/**
 * AgentService
 * Thin dependency-injection façade delegating orchestration to JourneyCoordinator.
 * Preserves NestJS injection and controller contracts.
 * Free of journey, model, tool, commerce, card, or business-domain logic.
 */
@Injectable()
export class AgentService {
  constructor(@Inject(JourneyCoordinator) private readonly coordinator: JourneyCoordinator) {}

  async listConnectors(tenantId: string, person: { sub?: string; role?: string; groups?: string[] } | undefined) {
    return this.coordinator.listConnectors(tenantId, person);
  }

  async getDashboard(tenantId: string, person: { sub?: string; role?: string; groups?: string[] } | undefined) {
    return this.coordinator.getDashboard(tenantId, person);
  }

  async processChat(request: ChatRequest): Promise<ChatResponse> {
    return this.coordinator.executeChat(request);
  }

  async processChatStream(
    request: ChatRequest,
    emit?: (event: string, data: any) => void
  ): Promise<void> {
    return this.coordinator.executeChatStream(request, emit);
  }
}
