import { getSupabase } from "./db";
import { calculateOrderPayment } from "../lib/pricing";
import { MercadoPagoPayer, MercadoPagoPreferenceRequest } from "../lib/mercadopago.types";
import { MercadoPagoService } from "./mercadopago.service";
import {
  CreatePaymentInput,
  PaymentInputError,
  isValidEmail,
  isPositiveInteger,
  validateCustomerInput,
  validateShippingInput,
  MAX_ORDER_ITEMS
} from "../lib/payment-input.validation";
import { logEvent, setOrderRef } from "../lib/log";
import {
  createOrderRecord,
  findOrderByIdempotencyKey,
  DuplicateOrderError,
  IdempotencyConflictError,
  isSameIdempotentOrder
} from "./orders.repository";
import { assertExpectedTotal, buildOrderQuote, OrderQuote, OrderQuoteError } from "./order-quote.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Checkout de Mercado Pago: crea la orden y la preferencia de pago (o reusa
//           la orden en un reintento). El pago notificado por webhook se procesa en
//           mercadopago-webhook.service.ts.
// POR QUÉ:  Antes vivía mezclado dentro de payment.service.ts junto con
//           envío, persistencia de órdenes y templates de email.
// ─────────────────────────────────────────────────────────────

export class MercadoPagoCheckoutService {
  private readonly mercadoPago: MercadoPagoService;

  constructor(private readonly env: Env) {
    this.mercadoPago = new MercadoPagoService(env.MP_ACCESS_TOKEN);
  }

  async createCheckout(input: CreatePaymentInput): Promise<{ init_point: string }> {
    this.validateInput(input);

    const supabase = getSupabase(this.env);
    const quote = await buildOrderQuote(this.env, input.items, input.shipping);
    // quote.subtotalArs ya incluye el embalaje (repartido en el precio de cada producto).
    const payment = calculateOrderPayment(
      quote.subtotalArs,
      quote.shippingArs,
      "mercadopago",
      quote.paymentCommissionPercentage
    );
    assertExpectedTotal(input.expected_total_ars, payment.total);

    if (input.idempotency_key) {
      // Reintento del mismo intento de pago (doble click, recarga, red): la orden
      // ya se creó y ya descontó stock. No se crea otra: se reusa esa misma orden
      // (con el total recalculado a la cotización vigente) para un nuevo link de pago.
      const existing = await findOrderByIdempotencyKey(this.env, input.idempotency_key);
      if (existing) {
        // Misma key pero otro pedido (o la orden ya se canceló): reusarla dejaría los ítems
        // viejos en la orden cobrando el total nuevo.
        if (!isSameIdempotentOrder(existing, input.items)) {
          throw new IdempotencyConflictError(existing.external_reference);
        }
        return this.reissuePreferenceForExistingOrder(existing, input, quote, payment);
      }
    }

    const externalReference = crypto.randomUUID();
    setOrderRef(externalReference);
    let createdOrder: { id: string };
    try {
      createdOrder = await createOrderRecord(
        this.env,
        input.customer,
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
        externalReference,
        input.shipping,
        quote.shippingArs,
        quote.embalajeArs,
        "mercadopago",
        payment.paymentDiscountPercentage,
        payment.paymentDiscountAmount,
        input.idempotency_key
      );
    } catch (error) {
      if (error instanceof DuplicateOrderError) {
        return this.reissuePreferenceForExistingOrder(
          { id: error.orderId, external_reference: error.externalReference },
          input,
          quote,
          payment
        );
      }
      throw error;
    }

    try {
      const preference = await this.mercadoPago.createPreference(
        this.buildPreference(input, quote, externalReference, createdOrder.id)
      );

      // El stock se descuenta al confirmar el pedido (botón Pagar), sin esperar
      // la aprobación del pago. decrement_order_stock es atómica e idempotente
      // (orders.stock_decremented_at): el webhook de aprobación no vuelve a
      // descontar. Si no alcanza el stock, el catch cancela la orden.
      const { error: stockError } = await supabase.rpc("decrement_order_stock", {
        p_order_id: createdOrder.id
      });
      if (stockError) throw new OrderQuoteError("Insufficient stock to complete the order");

      logEvent("log", "order_created", { order_id: createdOrder.id, payment_method: "mercadopago", total_ars: payment.total });
      return { init_point: preference.init_point };
    } catch (error) {
      await supabase
        .from("orders")
        .update({ status: "cancelled", payment_status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", createdOrder.id);
      throw error;
    }
  }

  /**
   * Reusa una orden pendiente ya creada (mismo idempotency_key) para un nuevo intento
   * de pago: no crea otra orden ni vuelve a descontar stock. Actualiza el total al de
   * la cotización vigente (nada se cobró todavía) y genera un link de pago nuevo, para
   * que la preferencia de Mercado Pago siempre coincida con orders.total_amount (el
   * webhook rechaza el pago si no coinciden).
   */
  private async reissuePreferenceForExistingOrder(
    existing: { id: string; external_reference: string },
    input: CreatePaymentInput,
    quote: OrderQuote,
    payment: ReturnType<typeof calculateOrderPayment>
  ): Promise<{ init_point: string }> {
    setOrderRef(existing.external_reference);
    const supabase = getSupabase(this.env);
    const { data: updatedRows, error: updateError } = await supabase
      .from("orders")
      .update({
        subtotal_amount: quote.subtotalArs,
        shipping_amount: quote.shippingArs,
        embalaje_amount: quote.embalajeArs,
        total_amount: payment.total,
        payment_discount_percentage: payment.paymentDiscountPercentage,
        payment_discount_amount: payment.paymentDiscountAmount,
        exchange_rate_used: quote.exchangeRate,
        updated_at: new Date().toISOString()
      })
      .eq("id", existing.id)
      .eq("status", "pending")
      .eq("payment_status", "pending")
      .select("id");
    if (updateError) throw new Error(`Unable to refresh duplicate order: ${updateError.message}`);
    if (!updatedRows?.length) {
      throw new OrderQuoteError("This order already has a payment in progress");
    }

    const preference = await this.mercadoPago.createPreference(
      this.buildPreference(input, quote, existing.external_reference, existing.id)
    );
    return { init_point: preference.init_point };
  }

  private validateInput(input: CreatePaymentInput): void {
    if (!input || !Array.isArray(input.items) || input.items.length === 0 || input.items.length > MAX_ORDER_ITEMS) {
      throw new PaymentInputError(`items must contain between 1 and ${MAX_ORDER_ITEMS} entries`);
    }

    if (!input.customer || !isValidEmail(input.customer.email)) {
      throw new PaymentInputError("customer.email is invalid");
    }
    validateCustomerInput(input.customer);

    validateShippingInput(input.shipping);

    for (const item of input.items) {
      if (!item || typeof item.variant_id !== "string" || !item.variant_id || !isPositiveInteger(item.quantity)) {
        throw new PaymentInputError("Each item requires a valid variant_id and positive quantity");
      }
    }
  }

  private buildPreference(
    input: CreatePaymentInput,
    quote: OrderQuote,
    externalReference: string,
    orderId: string
  ): MercadoPagoPreferenceRequest {
    const now = new Date();
    const expiration = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const appBaseUrl = this.env.APP_BASE_URL.replace(/\/$/, "");
    const payer: MercadoPagoPayer = {
      name: input.customer.nombre,
      email: input.customer.email,
      phone: {
        area_code: input.customer.codigoArea,
        number: input.customer.celular
      }
    };

    if (input.customer.cuit) {
      payer.identification = {
        type: "CUIT",
        number: input.customer.cuit.replace(/\D/g, "")
      };
    }

    return {
      external_reference: externalReference,
      notification_url: this.env.MP_WEBHOOK_NOTIFICATION_URL,
      back_urls: {
        success: `${appBaseUrl}/orden/exito`,
        pending: `${appBaseUrl}/orden/pendiente`,
        failure: `${appBaseUrl}/orden/error`
      },
      ...(appBaseUrl.includes("localhost") ? {} : { auto_return: "approved" as const }),
      binary_mode: false,
      statement_descriptor: "BROTALIA",
      expiration_date_from: now.toISOString(),
      expiration_date_to: expiration.toISOString(),
      payer,
      items: [
        // item.unit_price ya incluye el embalaje repartido de cada producto: no va
        // como línea aparte (sería cobrarlo dos veces).
        ...quote.items.map(item => ({
          id: item.id,
          title: item.title,
          description: item.description,
          quantity: item.quantity,
          currency_id: item.currency_id,
          unit_price: item.unit_price
        })),
        ...(quote.shippingArs > 0 ? [{
          id: "shipping",
          title: "Costo de envío",
          description: "Envío a domicilio",
          quantity: 1,
          currency_id: "ARS" as const,
          unit_price: quote.shippingArs
        }] : [])
      ],
      metadata: {
        order_id: orderId,
        external_reference: externalReference
      }
    };
  }
}
