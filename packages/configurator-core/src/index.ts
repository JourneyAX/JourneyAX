import { BomItem } from '@journeyax/shared-types';

/**
 * Calculates subtotals, GST, applied discounts, and grand totals for a Bill of Materials (BOM)
 */
export function calculateTotals(
  bom: BomItem[],
  taxRate: number,
  discountRate: number
) {
  const subtotal = bom.reduce((acc, item) => acc + item.price * item.quantity, 0);
  const discount = Number((subtotal * discountRate).toFixed(2));
  const preTaxTotal = subtotal - discount;
  const gst = Number((preTaxTotal * taxRate).toFixed(2));
  const total = Number((preTaxTotal + gst).toFixed(2));

  return {
    subtotal,
    discount,
    gst,
    total
  };
}

export * from './connectors';

