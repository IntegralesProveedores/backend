import { jsonResponse, errorResponse } from "../lib/response";
import { getSupabase } from "../services/db";
import { RouteContext } from "../lib/router";

const SELECT_COLUMNS = "bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position";

export async function handlePaymentTransferInfo({ env }: RouteContext) {
  try {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("payment_transfer_info")
      .select(SELECT_COLUMNS)
      .eq("active", true)
      .order("position", { ascending: true });

    if (error) {
      return errorResponse(error.message, 500);
    }

    return jsonResponse(data ?? [], 200, 60);
  } catch (e: any) {
    return errorResponse(`PaymentTransferInfo Handler Error: ${e.message}`, 500);
  }
}
