/**
 * Neutral primitives — the ONLY components a tenant card template may use.
 *
 * Nothing in here knows about a tenant, a product, a quote or a journey.
 * Tenant-specific composition (what a "product card" looks like for Dragon
 * Shield vs PlaceMakers) is JSON in Mongo (`card_templates`), rendered at
 * runtime against this catalog. Adding a tenant never adds a component here.
 *
 * Every prop that carries content is a DynamicValue so a template can bind it
 * to state: `{ "$state": "/product/title" }`, `{ "$item": "title" }` inside a
 * repeat, or `{ "$template": "${/product/price} ${/product/currency}" }`.
 */
import { z } from 'zod';

/** A prop that may be a literal or a json-render expression. */
const dyn = <T extends z.ZodTypeAny>(inner: T) =>
  z.union([inner, z.record(z.string(), z.unknown())]);

export const tone = z.enum([
  'default', 'muted', 'accent', 'success', 'warning', 'danger', 'inverse', 'brand',
]);
export const size = z.enum(['xs', 'sm', 'md', 'lg', 'xl']);
export const spacing = z.enum(['0', 'xs', 'sm', 'md', 'lg', 'xl']);
export const radius = z.enum(['none', 'sm', 'md', 'lg', 'pill']);
export const shadow = z.enum(['none', 'sm', 'md', 'lg']);

/** Raw CSS escape hatch for CMS authors; tokens are still preferred. */
const rawStyle = z.record(z.string(), z.union([z.string(), z.number()])).optional();

/** Value-carrying primitives fire a catalog action with the value merged into params. */
const valueAction = {
  action: z.string().optional(),
  params: z.record(z.string(), z.unknown()).optional(),
  valueKey: z.string().optional(),
};

export const primitives = {
  Box: {
    description:
      'Generic layout container (flex). Use for rows/columns, padding, borders and backgrounds. Children render inside.',
    props: z.object({
      direction: z.enum(['row', 'column']).default('column').optional(),
      gap: spacing.optional(),
      pad: spacing.optional(),
      align: z.enum(['start', 'center', 'end', 'stretch', 'baseline']).optional(),
      justify: z.enum(['start', 'center', 'end', 'between', 'around']).optional(),
      wrap: z.boolean().optional(),
      bg: z.enum(['none', 'surface', 'surface-alt', 'muted', 'accent-soft', 'brand', 'inverse']).optional(),
      border: z.boolean().optional(),
      radius: radius.optional(),
      shadow: shadow.optional(),
      width: z.string().optional(),
      maxWidth: z.string().optional(),
      minWidth: z.string().optional(),
      height: z.string().optional(),
      flex: z.union([z.number(), z.string()]).optional(),
      overflow: z.enum(['visible', 'hidden', 'auto']).optional(),
      className: z.string().optional(),
      style: rawStyle,
      testId: z.string().optional(),
    }),
  },
  Card: {
    description:
      'Elevated surface with tenant card styling (radius, border, shadow, surface background). Optional header/footer slots.',
    props: z.object({
      pad: spacing.optional(),
      gap: spacing.optional(),
      variant: z.enum(['default', 'outlined', 'flat', 'highlight']).optional(),
      selected: dyn(z.boolean()).optional(),
      interactive: z.boolean().optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
    slots: ['header', 'footer'] as string[],
  },
  Grid: {
    description: 'Responsive grid of children. Use with `repeat` to render one child per item.',
    props: z.object({
      columns: z.number().int().min(1).max(6).optional(),
      minItemWidth: z.string().optional(),
      gap: spacing.optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  Text: {
    description: 'Text run. Variant picks the type scale; bind `text` to state.',
    props: z.object({
      text: dyn(z.union([z.string(), z.number()])),
      variant: z
        .enum(['display', 'title', 'heading', 'subheading', 'body', 'small', 'caption', 'label', 'eyebrow', 'mono'])
        .optional(),
      tone: tone.optional(),
      weight: z.enum(['regular', 'medium', 'semibold', 'bold']).optional(),
      align: z.enum(['start', 'center', 'end']).optional(),
      lines: z.number().int().min(1).max(10).optional(),
      uppercase: z.boolean().optional(),
      html: z.boolean().optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  Image: {
    description: 'Image with aspect ratio and graceful fallback (icon placeholder) when the URL is missing or blocked.',
    props: z.object({
      src: dyn(z.string()).optional(),
      alt: dyn(z.string()).optional(),
      ratio: z.enum(['1:1', '4:3', '3:4', '16:9', '3:2', 'auto']).optional(),
      fit: z.enum(['cover', 'contain']).optional(),
      radius: radius.optional(),
      width: z.string().optional(),
      height: z.string().optional(),
      fallbackIcon: z.string().optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  Price: {
    description: 'Formatted money. `amount` is a number in major units; `compareAt` shows a strike-through original.',
    props: z.object({
      amount: dyn(z.union([z.number(), z.string(), z.null()])).optional(),
      currency: dyn(z.string()).optional(),
      compareAt: dyn(z.union([z.number(), z.null()])).optional(),
      size: size.optional(),
      tone: tone.optional(),
      note: dyn(z.string()).optional(),
      emptyText: z.string().optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  Badge: {
    description: 'Small pill label (e.g. "In stock", "Auto-added · required", "Recommended").',
    props: z.object({
      text: dyn(z.string()),
      tone: tone.optional(),
      variant: z.enum(['solid', 'soft', 'outline']).optional(),
      icon: z.string().optional(),
      uppercase: z.boolean().optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  StatusDot: {
    description: 'Coloured dot + label for availability / status lines.',
    props: z.object({
      label: dyn(z.string()),
      tone: tone.optional(),
      pulse: z.boolean().optional(),
      className: z.string().optional(),
    }),
  },
  Button: {
    description:
      'Action button. `action` names a catalog action (e.g. addToCart); params are resolved from state and sent with the event.',
    props: z.object({
      label: dyn(z.string()),
      variant: z.enum(['primary', 'secondary', 'ghost', 'link', 'danger']).optional(),
      size: size.optional(),
      icon: z.string().optional(),
      iconRight: z.string().optional(),
      fullWidth: z.boolean().optional(),
      disabled: dyn(z.boolean()).optional(),
      loading: dyn(z.boolean()).optional(),
      className: z.string().optional(),
      style: rawStyle,
    }),
  },
  Link: {
    description: 'External/internal link rendered as anchor.',
    props: z.object({
      label: dyn(z.string()),
      href: dyn(z.string()),
      external: z.boolean().optional(),
      tone: tone.optional(),
      className: z.string().optional(),
    }),
  },
  Icon: {
    description: 'Inline icon by name from the platform icon set (box, check, cart, truck, info, warning, star, spark, mic, plus, chevron-right, close, search, tag, ruler, shield, wrench, gift, user).',
    props: z.object({
      name: dyn(z.string()),
      size: size.optional(),
      tone: tone.optional(),
      className: z.string().optional(),
    }),
  },
  Divider: {
    description: 'Horizontal rule.',
    props: z.object({ spacing: spacing.optional(), tone: tone.optional() }),
  },
  Spacer: {
    description: 'Empty flexible or fixed space.',
    props: z.object({ size: spacing.optional(), grow: z.boolean().optional() }),
  },
  Chips: {
    description: 'Row of tappable suggestion chips; tapping emits `select` with the chip text. Bind `selected` to show which chip is currently chosen.',
    props: z.object({
      ...valueAction,
      items: dyn(z.array(z.string())),
      selected: dyn(z.string()).optional(),
      tone: tone.optional(),
      wrap: z.boolean().optional(),
      className: z.string().optional(),
    }),
  },
  KeyValue: {
    description: 'Label/value pair, used in spec tables and summaries.',
    props: z.object({
      label: dyn(z.string()),
      value: dyn(z.union([z.string(), z.number(), z.null()])),
      inline: z.boolean().optional(),
      tone: tone.optional(),
      className: z.string().optional(),
    }),
  },
  Table: {
    description: 'Simple data table. `columns` are headers; `rows` is an array of arrays or objects (bind to state).',
    props: z.object({
      columns: dyn(z.array(z.string())),
      rows: dyn(z.array(z.unknown())),
      keys: z.array(z.string()).optional(),
      dense: z.boolean().optional(),
      className: z.string().optional(),
    }),
  },
  Steps: {
    description: 'Vertical numbered steps (plan / install guide). `items` binds to an array of {title, detail?, status?}.',
    props: z.object({
      items: dyn(z.array(z.unknown())),
      current: dyn(z.number()).optional(),
      className: z.string().optional(),
    }),
  },
  Progress: {
    description: 'Progress bar 0..100.',
    props: z.object({
      value: dyn(z.number()),
      label: dyn(z.string()).optional(),
      tone: tone.optional(),
    }),
  },
  Alert: {
    description: 'Inline notice (info/success/warning/danger) with optional title.',
    props: z.object({
      title: dyn(z.string()).optional(),
      text: dyn(z.string()),
      tone: tone.optional(),
      icon: z.string().optional(),
      className: z.string().optional(),
    }),
  },
  Rating: {
    description: 'Star rating 0..5 with optional count.',
    props: z.object({
      value: dyn(z.number()),
      count: dyn(z.number()).optional(),
      size: size.optional(),
    }),
  },
  Swatches: {
    description: 'Colour/finish swatches. `items` binds to [{id,label,hex|imageUrl}]; emits `select` with the id.',
    props: z.object({
      ...valueAction,
      items: dyn(z.array(z.unknown())),
      selected: dyn(z.string()).optional(),
      size: size.optional(),
    }),
  },
  Quantity: {
    description: 'Quantity stepper; emits `change` with the new value.',
    props: z.object({
      ...valueAction,
      value: dyn(z.number()),
      min: z.number().optional(),
      max: z.number().optional(),
      size: size.optional(),
    }),
  },
  Select: {
    description: 'Dropdown; `options` [{value,label}] bound to state; emits `change`.',
    props: z.object({
      ...valueAction,
      value: dyn(z.string()).optional(),
      options: dyn(z.array(z.unknown())),
      placeholder: z.string().optional(),
      label: dyn(z.string()).optional(),
      size: size.optional(),
    }),
  },
  Markdown: {
    description: 'Lightweight markdown/plain text block (paragraphs, bullets, bold). Never renders raw HTML.',
    props: z.object({
      text: dyn(z.string()),
      tone: tone.optional(),
      className: z.string().optional(),
    }),
  },
} as const;

export type PrimitiveName = keyof typeof primitives;
