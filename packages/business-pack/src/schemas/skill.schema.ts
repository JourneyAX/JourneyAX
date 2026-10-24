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
