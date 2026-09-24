import { errorResponse, jsonResponse, priceChangedResponse } from "../lib/response";
import { findOrderDetail, findOrderStatusByReference, IdempotencyConflictError, OrderItemsLoadError } from "../services/orders.repository";
import { parseTransferOrderInput, PaymentInputError } from "../lib/payment-input.validation";
import { OrderQuoteError, PriceChangedError } from "../services/order-quote.service";
import { createTransferOrder, InsufficientStockError, TransferOrderResult } from "../services/transfer-order.service";
import { enforceRateLimit } from "../lib/rate-limit";
import { verifyTurnstile } from "../lib/turnstile";
import { readJsonBody } from "../lib/request";
import { abandonMercadoPagoOrder } from "../services/stock-release.service";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleCreateOrder({ request, env }: { request: Request; env: any }) {
  const limited = await enforceRateLimit(env, request, "orders");
  if (limited) return limited;

  try {
    const body = await readJsonBody(request) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") return errorResponse("Invalid JSON body", 400);

    // Este endpoint es solo para transferencia. Mercado Pago pasa por
    // /payments/create; aceptarlo acá dejaba órdenes "pending" sin pago ni stock.
    if (body.payment_method !== "transferencia") {
      return errorResponse("payment_method must be 'transferencia'; use /payments/create for Mercado Pago", 400);
    }

    const captchaFailure = await verifyTurnstile(env, request, body.turnstile_token as string | undefined);
    if (captchaFailure) return captchaFailure;

    const result = await createTransferOrder(env, parseTransferOrderInput(body));
    if (result.kind === "duplicate") {
      return jsonResponse({ order_ref: result.orderRef, duplicate: true });
    }
    return jsonResponse(createdOrderResponse(result));
  } catch (error: any) {
    if (error instanceof PaymentInputError || error instanceof OrderQuoteError) return errorResponse(error.message, 400);
    if (error instanceof IdempotencyConflictError) return errorResponse("idempotency_conflict", 409);
    if (error instanceof PriceChangedError) return priceChangedResponse(error.currentTotalArs, error.expectedTotalArs);
    if (error instanceof InsufficientStockError) {
      return errorResponse(error.message, 409, { supabase_error: error.supabaseMessage });
    }
    return errorResponse("Unable to create order", 500, { original_message: error?.message, stack: error?.stack });
  }
}

/** Cuerpo de la respuesta de POST /orders cuando se creó la orden (contrato con el frontend). */
function createdOrderResponse({ orderRef, quote, payment, customer }: Extract<TransferOrderResult, { kind: "created" }>) {
  return {
    items: quote.items.map(item => ({
      variant_id: item.variant_id,
      sku: item.sku,
      product_name: item.product_name,
      quantity: item.quantity,
      units_per_pack: item.units_per_pack,
      stock: item.stock,
      cost_usd_master: item.cost_usd_master,
      price_ars: item.price_ars,
      price_usd: item.price_usd,
      subtotal_ars: item.subtotal_ars,
      subtotal_usd: item.subtotal_usd,
      price_ars_no_discount: item.price_ars_no_discount,
      product: {
        id: item.product_id,
        name: item.product_name,
        cost_usd: item.cost_usd_master_original,
        units_per_pack_master: item.units_per_pack_master
      }
    })),
    total_ars: payment.total,
    shipping_ars: quote.shippingArs,
    embalaje_ars: quote.embalajeArs,
    // Total real (productos + envío + comisión) en USD; antes era solo el subtotal de productos.
    total_usd: Math.round((payment.total / quote.exchangeRate + Number.EPSILON) * 100) / 100,
    exchange_rate: quote.exchangeRate,
    order_ref: orderRef,
    payment_method: "transferencia",
    payment_discount_percentage: payment.paymentDiscountPercentage,
    payment_discount_amount: payment.paymentDiscountAmount,
    customer: {
      nombre: customer.nombre,
      email: customer.email,
      cuit: customer.cuit,
      codigoArea: customer.codigoArea,
      celular: customer.celular
    }
  };
}

/**
 * El cliente volvió de Mercado Pago sin pagar: cancela la orden y devuelve el stock.
 * `external_reference` es un UUID aleatorio que solo conoce quien inició el pago.
 * Responde siempre 200 con `cancelled` para no revelar si la orden existe.
 */
export async function handleAbandonOrder({ request, env }: { request: Request; env: any }) {
  const limited = await enforceRateLimit(env, request, "orders/abandon");
  if (limited) return limited;

  const body = await readJsonBody(request) as { external_reference?: unknown } | null;
  const externalReference = body?.external_reference;
  if (typeof externalReference !== "string" || !UUID_REGEX.test(externalReference)) {
    return errorResponse("Invalid external_reference", 400);
  }

  try {
    return jsonResponse({ cancelled: await abandonMercadoPagoOrder(env, externalReference) });
  } catch (e: any) {
    return errorResponse("Unable to release the order", 500, { original_message: e.message, stack: e.stack });
  }
}

export type OrderPaymentState = "approved" | "pending" | "rejected";

const REJECTED_PAYMENT_STATUSES = new Set(["rejected", "cancelled", "refunded", "charged_back"]);

/** Resume el estado de la orden en lo único que necesita la página de éxito. */
export function toOrderPaymentState(order: { status: string | null; payment_status: string | null }): OrderPaymentState {
  if (order.payment_status === "approved" || order.status === "paid") return "approved";
  if (order.status === "cancelled" || REJECTED_PAYMENT_STATUSES.has(order.payment_status ?? "")) return "rejected";
  return "pending";
}

/**
 * Estado del pago por N° de orden (`external_reference`), para que /orden/exito no confíe
 * en los parámetros con los que vuelve Mercado Pago. Sin autenticación: el UUID solo lo
 * conoce quien inició el pago, y la respuesta no incluye datos personales ni montos.
 */
export async function handleGetOrderPaymentState({ env, params, request }: { env: any; params: Record<string, string>; request: Request }) {
  const limited = await enforceRateLimit(env, request, "orders/status");
  if (limited) return limited;

  const externalReference = params.externalReference;
  if (!UUID_REGEX.test(externalReference)) return errorResponse("Invalid external_reference", 400);

  let order;
  try {
    order = await findOrderStatusByReference(env, externalReference);
  } catch {
    return errorResponse("Unable to load order status", 500);
  }
  if (!order) return errorResponse("Order not found", 404);

  return jsonResponse({ payment: toOrderPaymentState(order) });
}

/**
 * Devuelve el estado agregado de una orden para el futuro detalle de
 * /orden/:id. Este endpoint no exige autenticación (se accede solo con el
 * UUID de la orden), así que la respuesta se limita deliberadamente a
 * datos no sensibles: no incluye nombre, CUIT, teléfono ni dirección del
 * cliente. Ese detalle completo debe consultarse desde un canal
 * autenticado si se necesita en el futuro.
 */
export async function handleGetOrder({ env, params, request }: { env: any; params: Record<string, string>; request: Request }) {
  const limited = await enforceRateLimit(env, request, "orders/get");
  if (limited) return limited;

  const orderId = params.id;
  if (!UUID_REGEX.test(orderId)) return errorResponse("Invalid order id", 400);
  let detail;
  try {
    detail = await findOrderDetail(env, orderId);
  } catch (error) {
    if (error instanceof OrderItemsLoadError) return errorResponse("Unable to load order details", 500);
    throw error;
  }
  if (!detail) return errorResponse("Order not found", 404);

  const { order, items } = detail;
  return jsonResponse({
    order_ref: order.external_reference,
    status: order.status,
    payment_status: order.payment_status,
    shipping_status: order.shipping_status,
    created_at: order.created_at,
    items: items.map(item => ({
      id: item.id,
      variant_id: item.product_variant_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: Number(item.unit_price) * Number(item.quantity)
    })),
    totals: {
      subtotal_ars: order.subtotal_amount,
      shipping_ars: order.shipping_amount,
      total_ars: order.total_amount,
      payment_discount_percentage: order.payment_discount_percentage,
      payment_discount_amount: order.payment_discount_amount
    }
  });
}
