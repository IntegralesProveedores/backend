import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { resolveShippingRate } from "../services/shipping.service";
import { enforceRateLimit } from "../lib/rate-limit";
import { readJsonBody } from "../lib/request";
import { parseProductGroups } from "../lib/product-groups";

export async function handleShippingQuote({ env, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "shipping/quote");
  if (limited) return limited;

  const rawBody = await readJsonBody(request);
  if (!rawBody || typeof rawBody !== "object") return errorResponse("Invalid JSON body", 400);
  const body = rawBody as { postal_code?: unknown; province?: unknown; items?: unknown };
  const postalCode = body.postal_code;
  const province = typeof body.province === "string" && body.province.length <= 100 ? body.province : null;

  if (typeof postalCode !== "string" || !/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);
  const parsed = parseProductGroups(body.items);
  if ("error" in parsed) return errorResponse(parsed.error, 400);

  try {
    const resolution = await resolveShippingRate(env, postalCode, parsed.groups, province);
    if (!resolution) return jsonResponse({ postal_code: postalCode, zone: null, price_ars: null });

    return jsonResponse({
      postal_code: postalCode,
      zone: resolution.zone,
      price_ars: resolution.priceArs
    });
  } catch (e: any) {
    return errorResponse("Unable to quote shipping", 500, { original_message: e.message, stack: e.stack });
  }
}
