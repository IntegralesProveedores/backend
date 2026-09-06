import { errorResponse, jsonResponse } from "../lib/response";
import { parseCreatePaymentInput, PaymentInputError } from "../lib/payment-input.validation";
import { PaymentService } from "../services/mercadopago-checkout.service";
import { OrderQuoteError } from "../services/order-quote.service";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";

export async function handleCreatePayment({ request, env }: RouteContext): Promise<Response> {
  const limited = await enforceRateLimit(env, request, "payments/create");
  if (limited) return limited;

  try {
    const body = await request.json() as unknown;
    const input = parseCreatePaymentInput(body);
    const result = await new PaymentService(env).createCheckout(input);
    return jsonResponse(result);
  } catch (error: unknown) {
    if (error instanceof PaymentInputError || error instanceof OrderQuoteError) {
      return errorResponse(error.message, 400);
    }
    const message = error instanceof Error ? error.message : "Unable to create payment";
    const stack = error instanceof Error ? error.stack : undefined;
    return errorResponse("Unable to create payment", 500, { original_message: message, stack });
  }
}
