import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { resolveShippingRate } from "../services/payment.service";

export async function handleShippingQuote({ env, url }: RouteContext) {
  const postalCode = url.searchParams.get("postal_code") ?? "";
  const quantity = Number(url.searchParams.get("quantity"));

  if (!/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return jsonResponse({ postal_code: postalCode, zone: null, price_ars: null });
  }

  try {
    const resolution = await resolveShippingRate(env, postalCode, quantity);
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
