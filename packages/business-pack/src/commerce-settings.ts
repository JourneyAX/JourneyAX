import { z } from 'zod';
const Pricing = z.object({ currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/), symbol: z.string().min(1).max(10), taxRate: z.number().finite().min(0).max(1), discountRate: z.number().finite().min(0).max(1) });

/** Studio's existing pricing form is the authoring source. The runtime receives its frozen release copy; it never guesses tax or reads mutable settings per turn. */
export function compileCommerceSettings(pricing: unknown, existing?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (pricing === undefined || pricing === null) return existing;
  const checked = Pricing.safeParse(pricing);
  if (!checked.success) throw new Error('Configure currency, symbol, tax and discount in merchant pricing before publication.');
  return { ...existing, pricing: checked.data };
}
