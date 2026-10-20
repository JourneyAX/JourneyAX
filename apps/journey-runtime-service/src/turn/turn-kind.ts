import type { Decision } from '@journeyax/journey-core';
import type { OkfGateDecision } from '@journeyax/knowledge';
import type { ConversationPlan } from '../conversation';

export type TurnKind = 'fact' | 'card' | 'answer' | 'recommend' | 'howto';

export interface ResolveTurnKindInput {
  customerQuestion: string;
  decision: Decision;
  knowledgeGate?: OkfGateDecision | null;
  conversationPlan?: ConversationPlan | null;
  openQuestionIds?: string[];
}

export function resolveTurnKind(input: ResolveTurnKindInput): TurnKind {
  const { customerQuestion, decision, knowledgeGate, conversationPlan, openQuestionIds } = input;
  const question = customerQuestion.trim().toLowerCase();

  // 1. If a question/clarification card is shown on screen:
  if (Boolean(knowledgeGate?.clarification) || Boolean(conversationPlan?.showCards?.question)) {
    return 'card';
  }

  // 2. Pure fact turn: stage asking for a fact, or unresolved question facts being gathered
  if (decision.type === 'ask_fact') {
    return 'fact';
  }

  // 2. How-to: step-by-step guidance, instructions, installation, replacement, repair
  const isHowTo =
    (conversationPlan?.action === 'answer' && Boolean(decision.payload?.howTo)) ||
    /^(how\s+(?:to|do\s+i|can\s+i)|what\s+are\s+the\s+steps|steps\s+to|instructions\s+for|how\s+does\s+one)\b/i.test(question) ||
    /\b(how\s+to|how\s+do\s+i|installation|install|mounting|replacing|replace|repair|guide|instructions)\b/i.test(question);
  if (isHowTo) {
    return 'howto';
  }

  // 3. Recommend: product recommendations, bundles, shopping options
  const isRecommend =
    conversationPlan?.action === 'recommend' ||
    conversationPlan?.action === 'show' ||
    Boolean(conversationPlan?.products && conversationPlan.products.length > 0) ||
    /\b(recommend|recommendation|suggest|which\s+(?:one|product|option)|what\s+(?:screws|timber|nails|paint|tool|board|product)\s+(?:for|to|should)|best\s+for|options\s+for)\b/i.test(question);
  if (isRecommend) {
    return 'recommend';
  }

  // 4. Answer: explanation, specifications, evidence answer, technical details
  const isAnswer =
    conversationPlan?.action === 'answer' ||
    knowledgeGate?.mode === 'evidence_answer' ||
    /\b(tell me more|more info|more detail|tell me about|explain|details|specs|specifications|features|what is|difference between|why)\b/i.test(question);
  if (isAnswer) {
    return 'answer';
  }

  // Default to fact if unresolved questions exist without products, else answer
  if (openQuestionIds && openQuestionIds.length > 0) {
    return 'fact';
  }
  return 'answer';
}
