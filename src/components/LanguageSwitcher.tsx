'use client';

import { useJourney } from '@/context/JourneyContext';
import { LANGUAGES } from '@/lib/i18n';

/**
 * Language control.
 *
 * Sits in the chat header rather than on a settings page because the point
 * being demonstrated is that switching language does not restart anything:
 * the bag, the chosen sizes and the conversation all survive. A language
 * picker that reloaded the app would prove the opposite.
 *
 * Each language is written in its own script. Listing "Hindi" in English to
 * a Hindi speaker is the same mistake as a translated chat bubble under an
 * English button.
 */
export default function LanguageSwitcher() {
  const { state, dispatch, t } = useJourney();

  return (
    <label className="lang-switch" title={t('lang.label')}>
      <span className="lang-switch__label">{t('lang.label')}</span>
      <select
        className="lang-switch__select"
        value={state.language}
        onChange={e => {
          const next = e.target.value as typeof state.language;
          dispatch({ type: 'SET_LANGUAGE', language: next });
          // Tell the assistant too, so the conversation switches with the
          // chrome instead of carrying on in the previous language.
          const send = (window as unknown as {
            __handleUserMessage?: (t: string) => void;
          }).__handleUserMessage;
          const name = LANGUAGES.find(l => l.code === next)?.promptName ?? 'English';
          send?.(`Please continue in ${name} from now on.`);
        }}
      >
        {LANGUAGES.map(l => (
          <option key={l.code} value={l.code}>
            {l.label}
          </option>
        ))}
      </select>
    </label>
  );
}
