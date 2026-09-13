/**
 * Actions a card may raise. The storefront maps each to a JourneyContext
 * dispatch or a BFF call; the agent never executes them directly.
 * Names are stable contract — templates in Mongo reference them by name.
 */
import { z } from 'zod';

export const actions = {
  selectItem: {
    description: 'Customer picked an item (product/option) on a card.',
    params: z.object({ sku: z.string().optional(), id: z.string().optional(), kind: z.string().optional() }),
  },
  viewProduct: {
    description: 'Open the product detail view for a SKU.',
    params: z.object({ sku: z.string() }),
  },
  addToCart: {
    description: 'Add a SKU (with quantity) to the cart / quote.',
    params: z.object({ sku: z.string(), qty: z.number().int().min(1).default(1).optional() }),
  },
  addAllToCart: {
    description: 'Add every item currently on the card to the cart / quote.',
    params: z.object({ skus: z.array(z.string()).optional() }),
  },
  removeFromCart: {
    description: 'Remove a SKU from the cart / quote.',
    params: z.object({ sku: z.string() }),
  },
  setQuantity: {
    description: 'Change the quantity of a line.',
    params: z.object({ sku: z.string(), qty: z.number().int().min(0) }),
  },
  sendMessage: {
    description: 'Send text to the agent as if the customer typed it (suggestion chips, "Ask about this").',
    params: z.object({ text: z.string() }),
  },
  openPanel: {
    description: 'Open a named stage panel (e.g. tryOn, configurator, spacePlanner, fitment).',
    params: z.object({ panel: z.string(), sku: z.string().optional() }),
  },
  checkout: {
    description: 'Proceed to checkout / approve the quote. Payment always needs a human step.',
    params: z.object({}).optional(),
  },
  chooseOption: {
    description: 'Answer a clarifying choice (question id + chosen value).',
    params: z.object({ questionId: z.string(), value: z.string() }),
  },
  selectBranch: {
    description: 'Choose a fulfilment branch / store.',
    params: z.object({ branchId: z.string() }),
  },
  openUrl: {
    description: 'Open an external URL (product page on the merchant site).',
    params: z.object({ url: z.string() }),
  },
  setState: {
    description: 'Built-in: write a value into the card state model.',
    params: z.object({ statePath: z.string(), value: z.unknown() }),
  },
} as const;

export type ActionName = keyof typeof actions;
