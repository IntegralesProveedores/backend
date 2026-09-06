import { getSupabase } from "../services/db";
import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";

export async function handlePostalCode({ env, params, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "postal-code");
  if (limited) return limited;

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

    if (error) return errorResponse("Unable to look up postal code", 500, { supabase_error: error.message });
    if (!data) return errorResponse("Postal code not found", 404);

    return jsonResponse({
      postal_code: data.postal_code,
      province: data.province,
      locality: data.locality,
      county: data.county,
      country: "Argentina"
    }, 200, 86400);
  } catch (e: any) {
    return errorResponse("Unable to look up postal code", 500, { original_message: e.message, stack: e.stack });
  }
}
