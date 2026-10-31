# Demo prices (no more "Price on request")

PlaceMakers' catalogue holds a real price for only a handful of products (18 of 41,221 in the web copy of the product sheet), so most cards read "Price on request". For a **demo** that is a poor experience, so the catalogue mapping can give a product with no real price a made-up one.

## What it does

- Only a product with **no real price** is touched. A real price always wins.
- The made-up price is **the same every time** for the same product (it comes from the product's SKU), between **NZ$4.90 and NZ$480**, mostly toward the low end like a real range of building products, written like a shelf price (`$12.90`, `$47.50`, `$215`).
- A product marked "price on application" (status `POA`) stays unpriced on purpose.
- The product record says `priceIsDemo: true`, and the catalogue mapping check shows an info line "Demo prices are on" so nobody forgets.
- Nothing is written to the product data. The price is worked out when the product is read.

## Switching it on (needs the owner's yes; it publishes)

The setting is `catalogMapping.pricing.demoFallback`:

```json
{ "enabled": true, "currency": "NZD", "min": 4.9, "max": 480 }
```

Dry run (prints what would change, writes nothing):

```bash
npx tsx scripts/publish-placemakers-agent-pack.ts --demo-prices
```

To publish: add `--apply` (it publishes a new pack version; the previous one stays available to roll back to).

## Switching it off

Publish again without `--demo-prices`, or roll back to the previous pack version in the back office. **Never leave it on for a shop that sells for real.**
