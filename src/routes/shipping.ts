import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { resolveShippingRate } from "../services/shipping.service";
import { enforceRateLimit } from "../lib/rate-limit";
import { readJsonBody } from "../lib/request";
import { MAX_ORDER_ITEMS } from "../lib/payment-input.validation";

/** Tope de unidades por ítem: el plan de cajas itera según las unidades, así que un
 *  valor enorme podía agotar el CPU del Worker. */
const MAX_UNITS_PER_ITEM = 1_000_000;

export async function handleShippingQuote({ env, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "shipping/quote");
  if (limited) return limited;

  const rawBody = await readJsonBody(request);
  if (!rawBody || typeof rawBody !== "object") return errorResponse("Invalid JSON body", 400);
  const body = rawBody as { postal_code?: unknown; province?: unknown; items?: unknown };
  const postalCode = body.postal_code;
  const items = body.items;
  const province = typeof body.province === "string" && body.province.length <= 100 ? body.province : null;

  if (typeof postalCode !== "string" || !/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);
  if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ORDER_ITEMS) {
    return errorResponse(`items must contain between 1 and ${MAX_ORDER_ITEMS} entries`, 400);
  }
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || typeof (item as any).product_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((item as any).product_id) || !Number.isInteger((item as any).units) || (item as any).units <= 0 || (item as any).units > MAX_UNITS_PER_ITEM) {
      return errorResponse(`Invalid item at index ${index}`, 400);
    }
  }

  try {
    const resolution = await resolveShippingRate(env, postalCode, items as Array<{ product_id: string; units: number }>, province);
    if (!resolution) return jsonResponse({ postal_code: postalCode, zone: null, price_ars: null });

    return jsonResponse({
      postal_code: postalCode,
      zone: resolution.zone,
      price_ars: resolution.priceArs,
      box_count: resolution.boxCount,
      boxes: resolution.boxes
    });
  } catch (e: any) {
    return errorResponse("Unable to quote shipping", 500, { original_message: e.message, stack: e.stack });
  }
}
