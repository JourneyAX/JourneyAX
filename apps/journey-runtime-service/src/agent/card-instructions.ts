import { randomUUID } from 'node:crypto';
import type { UIInstruction } from '@journeyax/journey-core';
import { confirmCardState, readPending } from './confirmation';

/** Approval state is server-owned and must survive a reply or refresh even when the model calls no tool. */
export function withPendingApprovals(cards: Array<{ cardType: string; state: any }>, workspace: any, principalId: string, now = Date.now()) {
  const result = [...cards];
  for (const review of readPending(workspace).filter(entry => entry.principalId === principalId && Date.parse(entry.expiresAt) > now)) {
    if (!result.some(card => card.cardType === 'confirm' && card.state?.confirmationId === review.id)) result.push({ cardType: 'confirm', state: confirmCardState(review) });
  }
  return result;
}

/** Several approvals can have the same card type in one turn. Their identities must never collapse. */
export function instructionsForCards(cards: Array<{ cardType: string; state: any }>, turnId?: string): UIInstruction[] {
  const turn = turnId || randomUUID();
  return cards.map((card, index) => {
    const actionId = card.cardType === 'confirm' && typeof card.state?.confirmationId === 'string'
      ? `confirm-${card.state.confirmationId}` : `${card.cardType}-${turn}-${index}`;
    return { actionId, component: card.cardType, props: card.state,
      envelope: { name: 'presentCard', arguments: { card: { id: actionId, cardType: card.cardType, state: card.state } } } };
  });
}
