import { errorResponse, jsonResponse, priceChangedResponse } from "../lib/response";
import { parseCreatePaymentInput, PaymentInputError } from "../lib/payment-input.validation";
import { MercadoPagoCheckoutService } from "../services/mercadopago-checkout.service";
import { OrderQuoteError, PriceChangedError } from "../services/order-quote.service";
import { IdempotencyConflictError } from "../services/orders.repository";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";
import { verifyTurnstile } from "../lib/turnstile";
import { readJsonBody } from "../lib/request";

export async function handleCreatePayment({ request, env }: RouteContext): Promise<Response> {
  const limited = await enforceRateLimit(env, request, "payments/create");
  if (limited) return limited;

  try {
    const body = await readJsonBody(request);
    if (!body || typeof body !== "object") return errorResponse("Invalid JSON body", 400);

    const captchaFailure = await verifyTurnstile(env, request, (body as { turnstile_token?: unknown }).turnstile_token);
    if (captchaFailure) return captchaFailure;

    const input = parseCreatePaymentInput(body);
    const result = await new MercadoPagoCheckoutService(env).createCheckout(input);
    return jsonResponse(result);
  } catch (error: unknown) {
    if (error instanceof PriceChangedError) return priceChangedResponse(error.currentTotalArs, error.expectedTotalArs);
    if (error instanceof IdempotencyConflictError) return errorResponse("idempotency_conflict", 409);
    if (error instanceof PaymentInputError || error instanceof OrderQuoteError) {
      return errorResponse(error.message, 400);
    }
    const message = error instanceof Error ? error.message : "Unable to create payment";
    const stack = error instanceof Error ? error.stack : undefined;
    return errorResponse("Unable to create payment", 500, { original_message: message, stack });
  }
}
