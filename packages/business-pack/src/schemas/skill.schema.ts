import { z } from 'zod';

/**
 * A skill is a named, reusable piece of instructions an agent can carry (how to open a broad request, what to do after an
 * item is added, how to show a picture of the finished job). Skills are tenant data: the platform has no skill wording of
 * its own. An agent lists the skills it carries by id.
 *
 *   tier "always"     the instructions are part of the agent's prompt on every turn
 *   tier "on_demand"  only the name and description are in the prompt; the agent calls use_skill to read the instructions
 *                     when the customer's request calls for it (keeps the prompt short, lets the model decide)
 */
export const SkillDefinitionSchema = z.object({
  skillId: z.string().min(1).regex(/^[a-z0-9][a-z0-9_-]*$/, 'skillId is lower-case letters, digits, "-" or "_"'),
  name: z.string().min(1),
  description: z.string().min(1),
  instructions: z.string().min(1),
  tier: z.enum(['always', 'on_demand']).default('always'),
  /** Tools the skill relies on; shown in the customization screens, and checked against the agent's allowed tools. */
  tools: z.array(z.string()).default([]),
});

export type SkillDefinition = z.infer<typeof SkillDefinitionSchema>;

/** The skills of an agent, in the order the agent lists them; an id no skill defines is skipped (and reported by the validator). */
export function resolveAgentSkills(
  agent: { skills?: string[] | undefined } | undefined,
  skills: unknown,
): SkillDefinition[] {
  const ids = Array.isArray(agent?.skills) ? agent!.skills! : [];
  if (ids.length === 0 || !Array.isArray(skills)) return [];
  const byId = new Map<string, SkillDefinition>();
  for (const candidate of skills) {
    const parsed = SkillDefinitionSchema.safeParse(candidate);
    if (parsed.success) byId.set(parsed.data.skillId, parsed.data);
  }
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

/** Tenant settings for the "how many to buy" helper (pack `extensions.quantityHelper`). */
export const QuantityHelperSchema = z.object({
  /** Extra to buy for cuts and waste, as a percentage of what the area needs. */
  allowancePercent: z.number().min(0).max(100).optional(),
  /** Case-insensitive patterns whose first capture group is the square metres one pack covers, tried against a product's own text. */
  coveragePatterns: z.array(z.string().min(1).max(300)).max(20).optional(),
  /** A side shorter than this (mm) means the product is sold by length, not as a piece that covers an area. */
  minPieceSideMm: z.number().min(1).max(5000).optional(),
  /** Units of area the shop understands, each as square metres per unit, keyed by the unit written plainly (lower case, no spaces: "ft2", "sqft"). */
  areaUnits: z.record(z.string().min(1).max(30), z.number().positive().max(1_000_000)).optional(),
  /** The words on the quantity card's working lines. */
  labels: z.record(z.string(), z.string().max(80)).optional(),
}).strict();

/** Lookups to make the moment a customer's tap arrives (pack `extensions.eventPrefetch`), by kind of tap; `{sku}`, `{title}` and `{quantity}` name the tapped product. */
export const EventPrefetchSchema = z.record(
  z.string().min(1).max(40),
  z.array(z.object({
    tool: z.string().min(1).max(60),
    args: z.record(z.string().min(1).max(40), z.union([z.string().max(200), z.number(), z.boolean()])).default({}),
    /** Show what this lookup found on a card of this type when the agent does not present a card itself. */
    showAs: z.enum(['accessories', 'review']).optional(),
  }).strict()).max(6),
);

/** Tenant settings for pictures of the finished job (pack `extensions.visualiser`); a tenant without it has the feature off. */
export const VisualiserSchema = z.object({
  enabled: z.boolean().optional(),
  model: z.string().min(1).max(80).optional(),
  quality: z.enum(['low', 'medium', 'high']).optional(),
  size: z.enum(['1024x1024', '1536x1024', '1024x1536']).optional(),
  /** The prompt, with {scene} and {products} where the customer's words and the product names go. */
  promptTemplate: z.string().min(1).max(1000).optional(),
  /** Shown under every picture. */
  disclaimer: z.string().max(300).optional(),
  maxProducts: z.number().int().min(1).max(5).optional(),
}).strict();

/**
 * Tenant settings for reading a product's own guide (pack `extensions.productGuides`): the supplier's specification guide,
 * installation guide or instruction manual, as kept with the product record. A tenant without it has the feature off.
 */
export const ProductGuidesSchema = z.object({
  enabled: z.boolean().optional(),
  /**
   * Claim classes the supplier's own words may support in a reply (for example "installation_step" or "safety_instruction").
   * The reply guard holds back a sentence of a class nobody has verified; a tenant that accepts its suppliers' published
   * guides as the source for these names the classes here. Empty or absent: the guide is read but unlocks nothing.
   */
  unlocks: z.array(z.string().min(1).max(40)).max(12).optional(),
  /** Passages returned by one read, and the most characters of each. */
  maxPassages: z.number().int().min(1).max(20).optional(),
  passageChars: z.number().int().min(200).max(3000).optional(),
  /** A single guide up to this many characters is read whole, in its own order, instead of the best few passages (default 12000; 0 never). */
  wholeGuideChars: z.number().int().min(0).max(30000).optional(),
}).strict();

/**
 * Tenant settings for a signed-in business customer's own account (pack `extensions.customerAccount`): which connector answers when a customer
 * the back office has linked to a company asks about their deliveries, balance or prices, and which of its tools do each of the three jobs.
 * A tenant without it (or with `enabled` false) has the feature off: nobody is offered the account tools.
 */
export const CustomerAccountSchema = z.object({
  enabled: z.boolean().optional(),
  /** The connector that holds the accounts (its id in `extensions.connectors`). */
  connector: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/, 'a connector id uses letters, digits and _ . -').optional(),
  /** The connector's own tools for the three lookups; each must be a tool that only reads. */
  tools: z.object({
    balance: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    deliveries: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
    price: z.string().regex(/^[A-Za-z0-9_.-]{1,64}$/).optional(),
  }).strict().optional(),
}).strict();

/**
 * Tenant settings for reading the shop's own web pages (pack `extensions.contentPages`): project how-tos, inspiration, compliance
 * and trade-tool pages. A tenant without it has the feature off.
 */
export const ContentPagesSchema = z.object({
  enabled: z.boolean().optional(),
  /** Claim classes the shop's own pages may support in a reply (see `productGuides.unlocks`). Empty or absent: the page is read but unlocks nothing. */
  unlocks: z.array(z.string().min(1).max(40)).max(12).optional(),
  /** Passages returned by one read, and the most characters of each. */
  maxPassages: z.number().int().min(1).max(20).optional(),
  passageChars: z.number().int().min(200).max(3000).optional(),
  /** Pages listed by one search. */
  maxPages: z.number().int().min(1).max(10).optional(),
}).strict();

/**
 * Tenant settings for the last look before payment (pack `extensions.checkoutReview`): when on, the cart's checkout button first
 * asks the consultant for a review card (quantities, what else may be needed, pick-up or delivery, warranty and guides), and the
 * card's own button goes on to payment. A tenant without it pays straight away, as before.
 */
export const CheckoutReviewSchema = z.object({
  enabled: z.boolean().optional(),
  /** The words on the card (heading, section titles, button labels); anything left out keeps the platform's plain wording. */
  labels: z.record(z.string(), z.string().max(160)).optional(),
  /** What each way of fulfilling an order is called, by the code the product record uses (for example a code for collecting in store). */
  deliveryLabels: z.record(z.string(), z.string().max(80)).optional(),
  /** The most things listed under "what you may still need". */
  maxAccessories: z.number().int().min(0).max(8).optional(),
}).strict();

/**
 * Tenant settings for paying (pack `extensions.payment`): pay inside the storefront, in the side panel, instead of on the payment
 * provider's own page; and whether the payment form also asks where the order goes. A tenant without it keeps the provider's page.
 */
export const PaymentSchema = z.object({
  embedded: z.boolean().optional(),
  collectShipping: z.boolean().optional(),
  /** Two-letter country codes a delivery address may be in. */
  shippingCountries: z.array(z.string().regex(/^[A-Za-z]{2}$/)).max(20).optional(),
}).strict();

const HexColour = z.string().regex(/^#[0-9A-Fa-f]{6}$/, 'a colour as #rrggbb');

/**
 * Tenant colours for the working surfaces and buttons (pack `extensions.brandTheme`), taken from the shop's own website: the colour of
 * its main buttons, the text on them, its link colour, and the header of the cart, payment and order panels. Anything left out keeps the
 * shop's brand colour from its project settings.
 */
export const BrandThemeSchema = z.object({
  action: HexColour.optional(),
  actionText: HexColour.optional(),
  link: HexColour.optional(),
  canvasHeader: HexColour.optional(),
  canvasHeaderText: HexColour.optional(),
}).strict();

/**
 * How the shop's "what kind are you after?" questions are kept honest (pack `extensions.questionCards`). When a question offers the
 * groups of a department, the server requires every group that holds at least `minShelfShare` of the department's products to be among
 * the choices, and adds the shop's own words for "something that is not listed" (`otherOptionLabel`) so a customer is never left without
 * a choice to tap. Without `otherOptionLabel` no such choice is added.
 */
export const QuestionCardsSchema = z.object({
  otherOptionLabel: z.string().min(1).max(60).optional(),
  minShelfShare: z.number().min(0.01).max(0.5).optional(),
}).strict();

/**
 * Tenant phrase swaps for the consultant's voice (pack `extensions.voice`): a model that is told to speak as the shop's own team still
 * sometimes writes about the shop in the third person ("the shop's page says"). Each rule is a pattern and what replaces it ("our page
 * says"); only the words matched are swapped, and nothing is added. The shop's own wording, never the platform's.
 */
export const VoiceSchema = z.object({
  rewrites: z.array(z.object({
    pattern: z.string().min(1).max(200),
    replacement: z.string().max(80),
    flags: z.enum(['', 'i']).optional(),
  }).strict().superRefine((rule, ctx) => {
    try { new RegExp(rule.pattern, `${rule.flags ?? ''}g`); } catch { ctx.addIssue({ code: 'custom', message: `"${rule.pattern}" is not a valid pattern` }); }
  })).max(40),
}).strict();
