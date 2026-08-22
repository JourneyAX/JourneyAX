'use client';

import { useJourney } from '@/context/JourneyContext';
import { FitAdvisorFlow } from '@/components/fit/FitAdvisor';
import type { BodyEstimate, ZoneFit } from '@/lib/advisor-types';

/**
 * The Fit Advisor, mounted as a JourneyAX panel.
 *
 * The model opens this by calling showFitAdvisor mid-conversation, exactly
 * the way it opens products or a guide. Two consequences worth keeping:
 *
 *   · No dialog. The right-hand panel is already the surface, so the flow
 *     renders straight into it.
 *   · The answer goes back into the conversation. When the shopper accepts a
 *     size we push a message through the chat, so the assistant knows the
 *     size and can carry on — add it to the quote, check stock, whatever
 *     comes next. Without that the advisor would be a dead end that happens
 *     to sit inside a conversation.
 */
export default function FitAdvisorPanel() {
  const { state, dispatch } = useJourney();
  const garment = state.fitGarment;

  const handleUseSize = (
    size: string,
    summary: string,
    detail?: { body: BodyEstimate; zones: ZoneFit[] }
  ) => {
    // Carry the body/zone detail through — try-on needs it to draw this
    // shopper rather than a stock figure.
    dispatch({ type: 'SET_FIT_CHOICE', size, summary, body: detail?.body, zones: detail?.zones });
    dispatch({
      type: 'ADD_MESSAGE',
      role: 'note',
      head: 'Size chosen.',
      text: `${garment?.styleName ?? 'This item'} — size ${size}.`,
    });

    // Hand the answer back to the assistant so the journey continues.
    const send = (window as unknown as {
      __handleUserMessage?: (t: string) => void;
    }).__handleUserMessage;
    send?.(
      `I used the fit advisor and it recommended size ${size} (${summary}). `
      + `Please use that size from here on.`
    );
  };

  return (
    <div className="clarify-panel clarify-panel--with-footer">
      <div className="clarify-panel__scroll">
        <div className="clarify-panel__scroll-inner">
          <div className="clarify-panel__eyebrow">Fit Advisor</div>
          <h2 className="clarify-panel__heading">Let’s get the size right</h2>
          <p className="clarify-panel__desc">
            {garment
              ? 'A few seconds now beats a return later. Nothing is added to your order until you choose.'
              : 'Tell me which item you are looking at and I can size it for you.'}
          </p>

          {garment && (
            <div className="adv adv--inline" style={{ marginTop: 26 }}>
              <FitAdvisorFlow
                garment={garment}
                onUseSize={handleUseSize}
                ctaLabel={size => `Continue with ${size}`}
              />
            </div>
          )}

          {state.fitChoice && (
            <div className="adv-chosen">
              <span className="adv-chosen__mark" aria-hidden>✓</span>
              Size {state.fitChoice.size} carried into your order.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
