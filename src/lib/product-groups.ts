import { MAX_ORDER_ITEMS } from "./payment-input.validation";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Valida y normaliza el body { items: [{ product_id, units }] } de las
//           cotizaciones de envío y de embalaje.
// POR QUÉ:  Las dos rutas aceptan lo mismo; estaba escrito inline en shipping.ts.
// CUIDADO:  Las unidades tienen tope: el plan de cajas itera según las unidades, así
//           que un valor enorme podía agotar el CPU del Worker.
// ─────────────────────────────────────────────────────────────

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_UNITS_PER_ITEM = 1_000_000;

export type ProductGroupsResult =
  | { error: string }
  | { groups: Array<{ product_id: string; units: number }> };

export function parseProductGroups(items: unknown): ProductGroupsResult {
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ORDER_ITEMS) {
    return { error: `items must contain between 1 and ${MAX_ORDER_ITEMS} entries` };
  }

  const units = new Map<string, number>();
  for (const [index, item] of items.entries()) {
    const productId = item && typeof item === "object" ? (item as any).product_id : undefined;
    const itemUnits = item && typeof item === "object" ? (item as any).units : undefined;
    if (
      typeof productId !== "string" || !UUID_REGEX.test(productId) ||
      !Number.isInteger(itemUnits) || itemUnits <= 0 || itemUnits > MAX_UNITS_PER_ITEM
    ) {
      return { error: `Invalid item at index ${index}` };
    }
    units.set(productId, (units.get(productId) ?? 0) + itemUnits);
  }
  return { groups: Array.from(units, ([product_id, total]) => ({ product_id, units: total })) };
}
