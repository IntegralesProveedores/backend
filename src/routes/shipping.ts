import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { resolveShippingRate } from "../services/payment.service";

export async function handleShippingQuote({ env, request }: RouteContext) {
  const body = await request.json() as { postal_code?: unknown; items?: unknown };
  const postalCode = body?.postal_code;
  const items = body?.items;

  if (typeof postalCode !== "string" || !/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);
  if (!Array.isArray(items) || items.length === 0) return errorResponse("items must be a non-empty array", 400);
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== "object" || typeof (item as any).product_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test((item as any).product_id) || !Number.isInteger((item as any).units) || (item as any).units <= 0) {
      return errorResponse(`Invalid item at index ${index}`, 400);
    }
  }

  try {
    const resolution = await resolveShippingRate(env, postalCode, items as Array<{ product_id: string; units: number }>);
    if (!resolution) return jsonResponse({ postal_code: postalCode, zone: null, price_ars: null });

    return jsonResponse({
      postal_code: postalCode,
      zone: resolution.zone,
      price_ars: resolution.priceArs,
      box_count: resolution.boxCount,
      boxes: resolution.boxes
    });
  } catch (e: any) {
    return errorResponse(`Shipping quote Handler Error: ${e.message}`, 500, { stack: e.stack });
  }
}
