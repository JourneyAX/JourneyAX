/**
 * Message text sanitization utilities for JourneyAX chat.
 * Normalizes message text, removing leaked SVG markup, decoding HTML entities
 * like &#x20;, and stripping raw serialized UI envelopes.
 */

export function sanitizeMessageText(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let cleaned = raw
    .replace(/<svg[\s\S]*?<\/svg>/gi, '') // Strip any serialized SVG markup
    .replace(/svgsvg/gi, '')
    .replace(/&#x20;/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  // Strip accidental serialized UI envelope JSON
  if (cleaned.startsWith('{"') && (cleaned.includes('"uiInstructions"') || cleaned.includes('"cards"'))) {
    try {
      const parsed = JSON.parse(cleaned);
      if (parsed.assistantMessage) {
        return sanitizeMessageText(parsed.assistantMessage);
      }
      return '';
    } catch {}
  }

  return cleaned;
}
