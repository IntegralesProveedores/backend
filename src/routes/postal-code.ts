import { getSupabase } from "../services/db";
import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";

export async function handlePostalCode({ env, params }: RouteContext) {
  const postalCode = params.postalCode;

  if (!/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);

  try {
    const { data, error } = await getSupabase(env)
      .from("postal_codes_ar")
      .select("postal_code, province, locality, county")
      .eq("postal_code", postalCode)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (error) return errorResponse(error.message, 500);
    if (!data) return errorResponse("Postal code not found", 404);

    return jsonResponse({
      postal_code: data.postal_code,
      province: data.province,
      locality: data.locality,
      county: data.county,
      country: "Argentina"
    }, 200, 86400);
  } catch (e: any) {
    return errorResponse(`Postal code Handler Error: ${e.message}`, 500, { stack: e.stack });
  }
}
