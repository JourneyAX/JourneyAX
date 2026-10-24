/**
 * The opening screen's greeting. A tenant's own headline and subtitle (storefront config `intro`) win; without them the
 * greeting is neutral — a time-of-day hello to the signed-in person, or a plain question — and never names a business.
 */
export function timeOfDayHello(now: Date): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 18) return 'Good afternoon';
  if (h >= 18) return 'Good evening';
  return 'Hello';
}

/** "admin" → "Admin"; keeps the rest of the name as typed. */
export function displayFirstName(name: string | undefined | null): string {
  const first = String(name || '').trim().split(/\s+/)[0] || '';
  return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

export interface HeroCopy {
  title: string;
  subtitle: string;
}

export function resolveHero(input: {
  headline?: string | null;
  subtitle?: string | null;
  /** The tenant's opening message (persona greeting), already addressed to the person if it can be. */
  greeting?: string | null;
  name?: string | null;
  now?: Date;
}): HeroCopy {
  const headline = String(input.headline || '').trim();
  const subtitle = String(input.subtitle || '').trim();
  const name = displayFirstName(input.name);
  if (headline) return { title: headline, subtitle };
  const title = name ? `${timeOfDayHello(input.now || new Date())}, ${name}` : 'How can I help today?';
  // A long opening message reads as a paragraph under a headline; keep it only when it is short enough to be a subtitle.
  const greeting = String(input.greeting || '').trim();
  return { title, subtitle: subtitle || (greeting.length > 0 && greeting.length <= 260 ? greeting : '') };
}
