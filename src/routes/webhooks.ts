import { RouteContext } from "../lib/router";
import { errorResponse, jsonResponse } from "../lib/response";
import { PaymentService } from "../services/payment.service";

function normalizePaymentId(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  return null;
}

async function readWebhookPaymentId(request: Request, url: URL): Promise<string | null> {
  const queryDataId = normalizePaymentId(url.searchParams.get("data.id"));
  if (queryDataId) return queryDataId;

  const queryId = normalizePaymentId(url.searchParams.get("id"));
  if (queryId) return queryId;

  const contentType = request.headers.get("content-type") ?? "";
  const bodyText = await request.text();
  if (!bodyText.trim()) return null;

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText) as Record<string, unknown>;
      const bodyData = parsed.data;
      if (bodyData && typeof bodyData === "object") {
        const bodyDataId = normalizePaymentId((bodyData as Record<string, unknown>)["id"]);
        if (bodyDataId) {
          return bodyDataId;
        }
      }
    } catch {
      return null;
    }
  }

  const formData = new URLSearchParams(bodyText);
  return normalizePaymentId(formData.get("data.id") ?? formData.get("data[id]") ?? formData.get("id"));
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
    console.log(JSON.stringify({
      event: "mercadopago_webhook_ignored_topic",
      topic: notificationTopic,
      detail: !hasDataId && topic !== null
        ? "formato IPN legado"
        : "notificación sin data.id o con tipo distinto de payment"
    }));
    return jsonResponse({ success: true, ignored: true });
  }

  const requestId = request.headers.get("x-request-id");
  const xSignature = request.headers.get("x-signature");
  const paymentId = await readWebhookPaymentId(request, url);

  try {
    const paymentService = new PaymentService(env);
    if (!paymentId || !requestId) {
      return errorResponse("Missing Mercado Pago webhook identifiers", 400);
    }

    const signatureValid = await paymentService.mercadoPagoWebhookSignatureIsValid(
      xSignature,
      requestId,
      paymentId
    );
    if (!signatureValid) {
      console.warn(JSON.stringify({
        event: "mercadopago_webhook_rejected",
        request_id: requestId,
        payment_id: paymentId,
        duration_ms: Date.now() - startedAt
      }));
      return errorResponse("Invalid Mercado Pago webhook signature", 401);
    }

    const payment = await paymentService.getPayment(paymentId);
    await paymentService.processPayment(payment, requestId);

    console.log(JSON.stringify({
      event: "mercadopago_webhook_received",
      request_id: requestId,
      payment_id: String(payment.id),
      external_reference: payment.external_reference,
      status: payment.status,
      duration_ms: Date.now() - startedAt
    }));

    return jsonResponse({ success: true });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Unable to process Mercado Pago webhook";
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(JSON.stringify({
      event: "mercadopago_webhook_error",
      request_id: requestId,
      payment_id: paymentId,
      error: message,
      stack,
      duration_ms: Date.now() - startedAt
    }));
    return errorResponse(`Mercado Pago webhook error: ${message}`, 500, { stack });
  }
}
