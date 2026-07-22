import { errorResponse, jsonResponse } from "../lib/response";
import { parseCreatePaymentInput, PaymentInputError, PaymentService } from "../services/payment.service";
import { RouteContext } from "../lib/router";

export async function handleCreatePayment({ request, env }: RouteContext): Promise<Response> {
  try {
    const body = await request.json() as unknown;
    const input = parseCreatePaymentInput(body);
    const result = await new PaymentService(env).createCheckout(input);
    return jsonResponse(result);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to create payment";
    const stack = error instanceof Error ? error.stack : undefined;
    const status = error instanceof PaymentInputError ? 400 : 500;
    return errorResponse(`Payment creation error: ${message}`, status, { stack });
  }
}
