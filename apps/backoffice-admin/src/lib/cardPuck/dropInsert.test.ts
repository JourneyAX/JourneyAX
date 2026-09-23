/**
 * Schema placement: Price and the add-to-cart button belong inside the product card.
 *   npx tsx apps/backoffice-admin/src/lib/cardPuck/dropInsert.test.ts
 */
import { DEFAULT_TEMPLATES } from "@journeyax/ui-cards";
import { restoreElement, schemaElements } from "./dropInsert";
import { puckDataToSpec, specToPuckData, type PuckData, type PuckNode } from "./specAdapter";

let failures = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (!cond) {
    failures++;
    console.error(`✗ ${name}${extra ? `\n  ${extra}` : ""}`);
  } else {
    console.log(`✓ ${name}`);
  }
}

function strip(list: PuckNode[] | undefined, key: string): boolean {
  if (!list) return false;
  const at = list.findIndex((node) => node?.props?.jxId === key);
  if (at >= 0) {
    list.splice(at, 1);
    return true;
  }
  for (const node of list) {
    for (const slot of ["jxChildren", "jxHeader", "jxFooter"] as const) {
      const kids = node?.props?.[slot];
      if (Array.isArray(kids) && strip(kids as PuckNode[], key)) return true;
    }
  }
  return false;
}

const data = specToPuckData(DEFAULT_TEMPLATES.products);
const elements = schemaElements(data.content);
const price = elements.find((el) => el.key === "p-price");
const add = elements.find((el) => el.key === "p-cta");
const addAll = elements.find((el) => el.key === "addall");
check("price is a schema element", !!price);
check("price can only come back inside the product card", price?.homeKey === "p-card");
check("add to cart can only come back inside the product card", add?.homeKey === "p-card" && add?.label === "Add");
check("add all does not belong inside the product card", !!addAll && addAll.homeKey !== "p-card");
check("layout boxes are not draggable elements", elements.every((el) => !["Box", "Card", "Grid"].includes(el.type)));

const removed = JSON.parse(JSON.stringify(data)) as PuckData;
check("price can be removed", strip(removed.content, "p-price"));
const restored = restoreElement(removed, price!);
const spec = puckDataToSpec(restored!);
const foot = spec.elements["p-foot"]?.children || [];
check("price returns to the product card footer, ahead of the button", foot[0] === "p-price" && foot[1] === "p-cta", JSON.stringify(foot));
check("restored price still reads the item price", (spec.elements["p-price"]?.props?.amount as { $item?: string })?.$item === "price");
check("restoring a price that is already there does nothing", restoreElement(data, price!) === null);

if (failures) {
  console.error(`${failures} failed`);
  process.exit(1);
}
