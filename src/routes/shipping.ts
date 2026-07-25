import { getSupabase } from "../services/db";
import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";

export async function handleShippingQuote({ env, url }: RouteContext) {
  const postalCode = url.searchParams.get("postal_code") ?? "";

  if (!/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);

  try {
    const cp = Number.parseInt(postalCode, 10);
    const { data, error } = await getSupabase(env)
      .from("pricing_shipping_zones")
      .select("zone_name, price_ars")
      .eq("active", true)
      .lte("postal_code_from", cp)
      .gte("postal_code_to", cp)
      .order("price_ars", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) return errorResponse(error.message, 500);
    if (!data) return jsonResponse({ postal_code: postalCode, zone: null, price_ars: null });

    return jsonResponse({ postal_code: postalCode, zone: data.zone_name, price_ars: data.price_ars });
  } catch (e: any) {
    return errorResponse(`Shipping quote Handler Error: ${e.message}`, 500, { stack: e.stack });
  }
}
