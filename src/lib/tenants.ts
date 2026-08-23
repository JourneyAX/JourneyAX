// ═══════════════════════════════════════════════════════════════════════
// Tenants.
//
// JourneyAX is one engine serving different businesses. The shell — chat on
// the left, a panel the model drives on the right — is identical; what
// changes is the endpoint behind it, the branding, and the openers.
//
// Keeping this as data is what stops apparel features leaking into the
// bathroom journey and vice versa. A fit advisor has no business on a
// tapware quote, and a plumber's installation guide has none on a tee.
// ═══════════════════════════════════════════════════════════════════════

export interface TenantConfig {
  id: string;
  /** Which journey endpoint this shell talks to. */
  endpoint: string;
  brand: string;
  title: string;
  subtitle: string;
  badge: string;
  placeholder: string;
  /** Openers shown on the intro phase. */
  suggestions: string[];
  /** First bubble. Lives here so a tenant never greets you as another brand. */
  welcome: string;
  /**
   * Whether this journey has a bag, try-on, returns and a language picker.
   * Off for Caroma: a bathroom quote is not a shopping bag, and a plumber's
   * journey has nothing to try on. Same reasoning that keeps showFitAdvisor
   * off the bathroom route.
   */
  shopFeatures?: boolean;
}

export const CAROMA_TENANT: TenantConfig = {
  id: 'caroma',
  endpoint: '/api/chat',
  brand: 'CAROMA',
  title: 'Bathroom Configurator',
  subtitle: 'Agentic bathroom build',
  badge: 'Consumer · Bathroom',
  placeholder: 'Describe the build — product, quantity, finish…',
  suggestions: [
    "I'm renovating my bathroom — help me choose a new shower.",
    "I'm building new — spec a full bathroom with matching finishes.",
  ],
  welcome:
    "Welcome to the Caroma showroom! I'm your personal consultant — whether you're "
    + "renovating, fixing a problem, or just looking for inspiration, I'm here to help. "
    + 'What brings you in today?',
};

export const APPAREL_TENANT: TenantConfig = {
  id: 'apparel',
  endpoint: '/api/shop',
  brand: 'ABERCROMBIE & FITCH',
  title: 'Personal Shopper',
  subtitle: 'Agentic apparel journey',
  badge: 'Consumer · Apparel',
  placeholder: 'What are you shopping for?',
  suggestions: [
    'I need a plain tee for everyday wear.',
    'What size am I? The last one I bought was too small.',
    'Show me jeans — I usually wear a 27 waist.',
    'I want to return something that was too small.',
  ],
  welcome:
    "Hi — I'm your personal shopper. Tell me what you're after and I'll find it, "
    + "get the size right, show you how it looks, and keep it all in one bag. "
    + 'Switch language any time — nothing resets.',
  shopFeatures: true,
};
