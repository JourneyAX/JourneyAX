import { Injectable, Inject } from '@nestjs/common';
import { JourneyCoordinator } from './orchestration/journey-coordinator';
import { ChatRequest, ChatResponse } from './pipeline/types';

export * from './pipeline/types';
export * from './pipeline/turn-search-memo';
export * from './pipeline/context-assembler';
export * from './orchestration/tool-dispatcher';
export * from './llm/model-router';
export * from './pipeline/policy-enforcer';
export * from './commerce/storefront-commerce.service';
export * from './presentation/response-composer';
export * from './orchestration/journey-coordinator';

/**
 * AgentService
 * Thin dependency-injection façade delegating orchestration to JourneyCoordinator.
 * Preserves public exports, NestJS injection, and controller contracts.
 * Free of journey, model, tool, commerce, card, or business-domain logic.
 */
@Injectable()
export class AgentService {
  constructor(@Inject(JourneyCoordinator) private readonly coordinator: JourneyCoordinator) {}

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
