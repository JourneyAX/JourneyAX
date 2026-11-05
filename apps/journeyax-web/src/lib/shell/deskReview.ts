export interface DeskReview { projectId: string; person: string; recordId: string; sessionId: string; summary: string; cards: Array<{ cardType: string; state: Record<string, unknown> }> }
let handler: ((review: DeskReview) => boolean) | undefined;
export function registerDeskReviewHandler(next: (review: DeskReview) => boolean): () => void { handler = next; return () => { if (handler === next) handler = undefined; }; }
export function reviewDeskWork(review: DeskReview): boolean { return handler?.(review) ?? false; }
