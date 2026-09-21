import { getSupabase } from "../services/db";
import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";
import { pickPostalCodeProvince } from "../services/shipping.service";

export async function handlePostalCode({ env, params, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "postal-code");
  if (limited) return limited;

  const postalCode = params.postalCode;

  if (!/^\d{4}$/.test(postalCode)) return errorResponse("Invalid postal code format", 400);

  // Provincia elegida por el cliente cuando el código pertenece a más de una (opcional).
  const requestedProvince = new URL(request.url).searchParams.get("province");
  const preferredProvince = requestedProvince && requestedProvince.length <= 100 ? requestedProvince : null;

  try {
    // Mismo orden que resolveShippingRate: la provincia que se muestra es la que se cotiza.
    const { data, error } = await getSupabase(env)
      .from("postal_codes_ar")
      .select("postal_code, province, locality, county")
      .eq("postal_code", postalCode)
      .order("created_at", { ascending: true })
      .order("province", { ascending: true })
      .order("id", { ascending: true });

    if (error) return errorResponse("Unable to look up postal code", 500, { supabase_error: error.message });
    if (!data?.length) return errorResponse("Postal code not found", 404);

    const province = pickPostalCodeProvince(data, preferredProvince);
    const row = data.find(candidate => candidate.province === province) ?? data[0];

    return jsonResponse({
      postal_code: row.postal_code,
      province: row.province,
      // Provincias entre las que el cliente puede elegir (más de una solo en códigos compartidos).
      provinces: [...new Set(data.map(candidate => candidate.province))],
      locality: row.locality,
      county: row.county,
      country: "Argentina"
    }, 200, 86400);
  } catch (e: any) {
    return errorResponse("Unable to look up postal code", 500, { original_message: e.message, stack: e.stack });
  }
}
