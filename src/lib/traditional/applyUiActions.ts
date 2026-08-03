import type { UiAction } from './engine';

type Dispatch = (action: {
  type: string;
  [key: string]: unknown;
}) => void;

/** Shared UI-action applicator for traditional (and AI) tool payloads. */
export function applyUiActions(
  uiActions: UiAction[],
  dispatch: Dispatch
): { hasPhaseChange: boolean } {
  let hasPhaseChange = false;

  for (const action of uiActions || []) {
    if (action.name === 'setPhase') {
      hasPhaseChange = true;
      dispatch({ type: 'SET_PHASE', phase: action.arguments.phase });
      if (action.arguments.phase === 'clarify' && action.arguments.questions) {
        dispatch({
          type: 'SET_DYNAMIC_QUESTIONS',
          questions: action.arguments.questions,
        });
      }
    } else if (action.name === 'updateQuote') {
      const items = (action.arguments.items as Array<Record<string, unknown>>) || [];
      const bom = items.map((item) => ({
        id: item.sku,
        name: item.name,
        price: item.price,
        spec: item.reason || item.category || '',
        sku: item.sku,
        imageUrl: item.imageUrl || undefined,
        category: item.category || '',
        required: item.required || false,
        reason: item.reason,
        quantity: item.quantity || 1,
        lineTotal: Number(item.price || 0) * Number(item.quantity || 1),
        stock: { label: 'In stock · NSW DC', color: '#4E7C59' },
      }));
      dispatch({
        type: 'SET_QUOTE_DATA',
        title: action.arguments.title,
        bom,
        jobId: action.arguments.jobId,
        installationSummary: action.arguments.installationSummary,
        warrantySummary: action.arguments.warrantySummary,
      });
    } else if (action.name === 'showProducts') {
      dispatch({
        type: 'SET_RECOMMENDED_PRODUCTS',
        products: action.arguments.products,
      });
    } else if (action.name === 'showGuide') {
      dispatch({
        type: 'SET_GUIDE_STEPS',
        steps: action.arguments.steps,
      });
      hasPhaseChange = true;
    }
  }

  if (!hasPhaseChange && uiActions.some((a) => a.name === 'updateQuote')) {
    dispatch({ type: 'SET_PHASE', phase: 'quote' });
    hasPhaseChange = true;
  }
  if (!hasPhaseChange && uiActions.some((a) => a.name === 'showProducts')) {
    dispatch({ type: 'SET_PHASE', phase: 'products' });
    hasPhaseChange = true;
  }

  return { hasPhaseChange };
}
