import { jsonResponse, errorResponse } from "../lib/response";
import { getSupabase } from "../services/db";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";

const SELECT_COLUMNS = "bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position";

export async function handlePaymentTransferInfo({ env, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "payment-transfer-info");
  if (limited) return limited;

  try {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("payment_transfer_info")
      .select(SELECT_COLUMNS)
      .eq("active", true)
      .order("position", { ascending: true });

    if (error) {
      return errorResponse("Unable to load payment transfer info", 500, { supabase_error: error.message });
    }

    return jsonResponse(data ?? [], 200, 60);
  } catch (e: any) {
    return errorResponse("Unable to load payment transfer info", 500, { original_message: e.message, stack: e.stack });
  }
}
