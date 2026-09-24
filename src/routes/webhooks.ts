import { RouteContext } from "../lib/router";
import { errorResponse, jsonResponse } from "../lib/response";
import { logEvent, setOrderRef } from "../lib/log";
import { MercadoPagoWebhookService } from "../services/mercadopago-webhook.service";

function normalizePaymentId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

export async function handleMercadoPagoWebhook({ request, env, url }: RouteContext): Promise<Response> {
  const startedAt = Date.now();
  const topic = url.searchParams.get("topic");
  const type = url.searchParams.get("type");
  const hasDataId = url.searchParams.has("data.id");
  const notificationTopic = topic ?? type;
  if (
    !hasDataId ||
    (topic !== null && topic !== "payment") ||
    (type !== null && type !== "payment")
  ) {
    logEvent("log", "mercadopago_webhook_ignored_topic", {
      topic: notificationTopic,
      detail: !hasDataId && topic !== null
        ? "formato IPN legado"
        : "notificación sin data.id o con tipo distinto de payment"
    });
    return jsonResponse({ success: true, ignored: true });
  }

  const requestId = request.headers.get("x-request-id");
  const xSignature = request.headers.get("x-signature");
  // El handler ya exigió `data.id` en la query (formato actual de MP), y es el
  // mismo valor que entra en la firma; no se lee del body.
  const paymentId = normalizePaymentId(url.searchParams.get("data.id"));

  try {
    const paymentService = new MercadoPagoWebhookService(env);
    if (!paymentId || !requestId) {
      return errorResponse("Missing Mercado Pago webhook identifiers", 400);
    }

    const signatureValid = await paymentService.mercadoPagoWebhookSignatureIsValid(
      xSignature,
      requestId,
      paymentId
    );
    if (!signatureValid) {
      logEvent("warn", "mercadopago_webhook_rejected", {
        mp_request_id: requestId,
        payment_id: paymentId,
        duration_ms: Date.now() - startedAt
      });
      return errorResponse("Invalid Mercado Pago webhook signature", 401);
    }

    const payment = await paymentService.getPayment(paymentId);
    setOrderRef(payment.external_reference);
    await paymentService.processPayment(payment, requestId);

    logEvent("log", "mercadopago_webhook_received", {
      mp_request_id: requestId,
      payment_id: String(payment.id),
      status: payment.status,
      duration_ms: Date.now() - startedAt
    });

    return jsonResponse({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to process Mercado Pago webhook";
    const stack = error instanceof Error ? error.stack : undefined;
    logEvent("error", "mercadopago_webhook_error", {
      mp_request_id: requestId,
      payment_id: paymentId,
      error: message,
      stack,
      duration_ms: Date.now() - startedAt
    });
    return errorResponse("Unable to process Mercado Pago webhook", 500, { original_message: message, stack });
  }
}
