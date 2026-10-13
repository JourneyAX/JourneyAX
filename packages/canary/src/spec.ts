import { z } from 'zod';

const Expect = z.object({
  cards: z.object({ require: z.array(z.string()).default([]), forbid: z.array(z.string()).default([]) }).strict().optional(),
  text: z.object({
    /** At least one of these (regular expressions, case-insensitive) must match the reply. */
    matchesAny: z.array(z.string()).default([]),
    mustNotMatch: z.array(z.string()).default([]),
  }).strict().optional(),
  capabilities: z.object({ require: z.array(z.string()).default([]), forbid: z.array(z.string()).default([]) }).strict().optional(),
  maxLatencyMs: z.number().int().positive().optional(),
  /** The reply may legitimately be only cards. */
  allowNoText: z.boolean().optional(),
  /** This turn is expected to end with a customer-safe error. */
  error: z.boolean().optional(),
}).strict();

export const CanarySpecSchema = z.object({
  tenantId: z.string().regex(/^[a-z0-9-]+$/),
  version: z.string().min(1),
  /** Currency every priced item must carry (the shop's own); omitted means "not checked". */
  expectedCurrency: z.string().regex(/^[A-Z]{3}$/).optional(),
  /** Added to the platform's forbidden lists. */
  forbiddenCapabilities: z.array(z.string()).default([]),
  extraLeakPatterns: z.array(z.object({ id: z.string(), pattern: z.string() }).strict()).default([]),
  scenarios: z.array(z.object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,80}$/i),
    description: z.string().min(3).max(300),
    /** Sequential customer messages of one conversation. They are read-only questions: a canary never buys. */
    turns: z.array(z.object({ message: z.string().min(1).max(500), expect: Expect.default({}) }).strict()).min(1).max(10),
  }).strict()).min(1).max(200),
}).strict();
export type CanarySpec = z.infer<typeof CanarySpecSchema>;
export type TurnExpectation = z.infer<typeof Expect>;
