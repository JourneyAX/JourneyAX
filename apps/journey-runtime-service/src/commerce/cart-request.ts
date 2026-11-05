import { z } from 'zod';
import { PAID_ORDER_LIMITS } from '@journeyax/shared-types';
export const CartSessionSchema = z.string().trim().min(1).max(200).regex(/^[^\u0000-\u001f\u007f]+$/);
export const CartRequestSchema = z.object({
  sessionId: CartSessionSchema,
  idempotencyKey: z.string().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/),
  expectedVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  items: z.array(z.object({ sku: z.string().trim().min(1).max(200), quantity: z.number().int().positive().max(PAID_ORDER_LIMITS.maxQuantityPerLine) }).strict()).max(PAID_ORDER_LIMITS.maxLines),
}).strict();
