import { getSupabase } from "./db";
import { calculateOrderPayment, OrderPaymentResult } from "../lib/pricing";
import { logEvent, setOrderRef } from "../lib/log";
import { parseExpectedTotal, PaymentCustomerInput, TransferOrderInput } from "../lib/payment-input.validation";
import {
  createOrderRecord,
  DuplicateOrderError,
  findOrderByIdempotencyKey,
  IdempotencyConflictError,
  isSameIdempotentOrder
} from "./orders.repository";
import { assertExpectedTotal, buildOrderQuote, OrderQuote } from "./order-quote.service";
import { sendTransferOrderConfirmationEmail } from "./email/order-confirmation-templates";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Caso de uso "crear un pedido por transferencia": idempotencia, cotización,
//           control del total, alta de la orden, descuento de stock y mail.
// POR QUÉ:  Antes vivía entero dentro del handler HTTP (routes/orders.ts). Es el
//           equivalente de MercadoPagoCheckoutService.createCheckout para Mercado Pago.
// CUIDADO:  No conoce Request/Response: informa los casos esperados con errores tipados
//           (IdempotencyConflictError, OrderQuoteError, PriceChangedError,
//           PaymentInputError, InsufficientStockError) y la ruta los traduce a HTTP.
// ─────────────────────────────────────────────────────────────

/** La orden se creó pero decrement_order_stock no encontró stock: la orden se borró. */
export class InsufficientStockError extends Error {
  constructor(public readonly supabaseMessage: string) {
    super("Insufficient stock to complete the order");
    this.name = "InsufficientStockError";
  }
}

export type TransferOrderResult =
  /** Reintento del mismo pedido (misma idempotency_key): no se creó nada nuevo. */
  | { kind: "duplicate"; orderRef: string }
  | {
      kind: "created";
      orderRef: string;
      quote: OrderQuote;
      payment: OrderPaymentResult;
      customer: PaymentCustomerInput;
    };

export async function createTransferOrder(env: Env, input: TransferOrderInput): Promise<TransferOrderResult> {
  const { items, customer, shipping, idempotencyKey } = input;

  if (idempotencyKey) {
    // Reintento del mismo intento de pago (doble click, recarga, red): la orden
    // ya se creó, se devuelve su referencia en vez de crear una duplicada.
    const existing = await findOrderByIdempotencyKey(env, idempotencyKey);
    if (existing) {
      setOrderRef(existing.external_reference);
      // Misma key pero otro pedido (o la orden ya se canceló): no se devuelve la orden vieja
      // como si fuera ésta. El frontend genera una key nueva y el cliente confirma de nuevo.
      if (!isSameIdempotentOrder(existing, items)) {
        logEvent("warn", "idempotency_conflict", { order_ref: existing.external_reference });
        throw new IdempotencyConflictError(existing.external_reference);
      }
      return { kind: "duplicate", orderRef: existing.external_reference };
    }
  }

  const quote = await buildOrderQuote(env, items, shipping);
  // quote.subtotalArs ya incluye el embalaje (repartido en el precio de cada producto).
  const payment = calculateOrderPayment(quote.subtotalArs, quote.shippingArs, "transferencia", quote.paymentCommissionPercentage);
  assertExpectedTotal(parseExpectedTotal(input.expectedTotalArs), payment.total);

  const orderRef = crypto.randomUUID();
  setOrderRef(orderRef);

  let order: { id: string };
  try {
    order = await createOrderRecord(
      env,
      customer,
      quote.items.map(item => ({
        variant_id: item.variant_id,
        product_id: item.product_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        units_per_pack: item.units_per_pack,
        units_per_pack_master: item.units_per_pack_master,
        unit_price: item.price_ars
      })),
      quote.subtotalArs,
      quote.exchangeRate,
      orderRef,
      shipping,
      quote.shippingArs,
      quote.embalajeArs,
      "transferencia",
      payment.paymentDiscountPercentage,
      payment.paymentDiscountAmount,
      idempotencyKey
    );
  } catch (error) {
    if (error instanceof DuplicateOrderError) return { kind: "duplicate", orderRef: error.externalReference };
    throw error;
  }

  // El stock se descuenta al confirmar el pedido (no al acreditarse la transferencia).
  // decrement_order_stock es atómica e idempotente (orders.stock_decremented_at); si no
  // alcanza el stock, se revierte la orden y no se manda el mail.
  const supabase = getSupabase(env);
  const { error: stockError } = await supabase.rpc("decrement_order_stock", { p_order_id: order.id });
  if (stockError) {
    await supabase.from("orders").delete().eq("id", order.id);
    throw new InsufficientStockError(stockError.message);
  }

  logEvent("log", "order_created", { order_id: order.id, payment_method: "transferencia", total_ars: payment.total });

  const ivaTax = quote.taxes.find(t => t.name.toUpperCase() === "IVA");
  const vatLabel = ivaTax?.is_computable ? "IVA Incluido" : "IVA no incluido";
  const volumeDiscountPercentage = quote.subtotalNoDiscountArs <= 0
    ? 0
    : Math.max(0, Math.round((1 - quote.subtotalArs / quote.subtotalNoDiscountArs) * 100));

  await sendTransferOrderConfirmationEmail(env, {
    orderRef,
    customer,
    items: quote.items.map(item => ({
      product_name: item.product_name,
      sku: item.sku,
      quantity: item.quantity,
      units_per_pack: item.units_per_pack,
      subtotal_ars: item.subtotal_ars,
      price_ars_no_discount: item.price_ars_no_discount,
      price_ars_no_tax: item.price_ars_no_tax,
      image_url: item.image_url
    })),
    shipping,
    shippingAmountArs: quote.shippingArs,
    packagingBoxes: quote.packagingBoxes,
    totalArs: payment.total,
    volumeDiscountPercentage,
    vatLabel,
    transferDiscount: {
      percentage: payment.paymentDiscountPercentage,
      amountArs: payment.paymentDiscountAmount
    }
  });

  return { kind: "created", orderRef, quote, payment, customer };
}
