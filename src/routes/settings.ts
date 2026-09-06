import { getExchangeRate } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { getSupabase } from "../services/db";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";

export async function handleSettings({ env, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "settings");
  if (limited) return limited;

  try {
    const rate = await getExchangeRate(env);
    
    try {
      const supabase = getSupabase(env);
      const { data, error } = await supabase
        .from("settings")
        .select("usd_exchange_rate, updated_at")
        .eq("id", true)
        .single();

      if (error || !data) {
        return jsonResponse({ 
          usd_exchange_rate: rate, 
          updated_at: new Date().toISOString(),
          source: "external_fallback" 
        }, 200, 0);
      }

      return jsonResponse({ ...data, source: "db" }, 200, 0);
    } catch (dbError) {
      return jsonResponse({ 
        usd_exchange_rate: rate, 
        updated_at: new Date().toISOString(),
        source: "external_only" 
      }, 200, 0);
    }
  } catch (e: any) {
    return errorResponse("Unable to load settings", 500, { original_message: e.message, stack: e.stack });
  }
}
