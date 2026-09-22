import { getSupabase } from "./db";
import { calculateOrderPayment } from "../lib/pricing";
import {
  MercadoPagoPayer,
  MercadoPagoPaymentResponse,
  MercadoPagoPreferenceRequest,
  MercadoPagoPaymentStatus
} from "../lib/mercadopago.types";
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
import { createOrderRecord } from "./orders.repository";
import { sendMercadoPagoOrderConfirmationEmail } from "./email/order-confirmation-templates";
import { assertExpectedTotal, buildOrderQuote, OrderQuote, OrderQuoteError } from "./order-quote.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Checkout de Mercado Pago (crear preferencia + procesar el pago
//           notificado por webhook).
// POR QUÉ:  Antes vivía mezclado dentro de payment.service.ts junto con
//           envío, persistencia de órdenes y templates de email.
// ─────────────────────────────────────────────────────────────

interface PaymentRow {
  id: string;
  order_id: string;
  external_payment_id: string;
  status: MercadoPagoPaymentStatus;
}

interface OrderPaymentRow {
  id: string;
  total_amount: number | string;
  status: string;
  payment_status: string;
}

export class PaymentService {
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
    const externalReference = crypto.randomUUID();
    const createdOrder = await createOrderRecord(
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
      payment.paymentDiscountAmount
    );

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

      return { init_point: preference.init_point };
    } catch (error) {
      await supabase
        .from("orders")
        .update({ status: "cancelled", payment_status: "rejected", updated_at: new Date().toISOString() })
        .eq("id", createdOrder.id);
      throw error;
    }
  }

  async getPayment(paymentId: string): Promise<MercadoPagoPaymentResponse> {
    return this.mercadoPago.getPayment(paymentId);
  }

  async mercadoPagoWebhookSignatureIsValid(
    xSignature: string | null,
    xRequestId: string | null,
    dataId: string | null
  ): Promise<boolean> {
    return this.mercadoPago.validateWebhookSignature(
      xSignature,
      xRequestId,
      dataId,
      this.env.MP_WEBHOOK_SECRET
    );
  }

  async processPayment(
    payment: MercadoPagoPaymentResponse,
    requestId: string
  ): Promise<void> {
    const supabase = getSupabase(this.env);
    const externalReference = payment.external_reference;
    if (!externalReference) {
      throw new Error(`Payment ${payment.id} has no external_reference`);
    }

    const { data: orderData, error: orderError } = await supabase
      .from("orders")
      .select("id, total_amount, status, payment_status")
      .eq("external_reference", externalReference)
      .single();
    if (orderError || !orderData) {
      throw new Error(`Order not found for external_reference ${externalReference}`);
    }

    const order = orderData as unknown as OrderPaymentRow;
    if (order.status === "paid" && order.payment_status === "approved") {
      console.log(JSON.stringify({
        event: "mercadopago_payment_idempotent_skip",
        request_id: requestId,
        payment_id: String(payment.id),
        external_reference: externalReference,
        payment_status: payment.status,
        update_result: "already_approved"
      }));
      return;
    }

    if (payment.currency_id !== "ARS" || Math.abs(Number(payment.transaction_amount) - Number(order.total_amount)) > 0.01) {
      throw new Error(`Payment ${payment.id} does not match order amount or currency`);
    }

    const paymentId = String(payment.id);
    const { data: existingData } = await supabase
      .from("payments")
      .select("id, order_id, external_payment_id, status")
      .eq("external_payment_id", paymentId)
      .maybeSingle();
    const existingPayment = existingData as unknown as PaymentRow | null;

    if (existingPayment && existingPayment.order_id !== order.id) {
      throw new Error(`Payment ${paymentId} is linked to a different order`);
    }

    if (!existingPayment) {
      const { error: insertError } = await supabase.from("payments").insert({
        order_id: order.id,
        external_payment_id: paymentId,
        idempotency_key: paymentId,
        amount: payment.transaction_amount,
        currency: payment.currency_id,
        status: payment.status,
        paid_at: payment.date_approved,
        updated_at: new Date().toISOString()
      });

      if (insertError) {
        const { data: concurrentPayment } = await supabase
          .from("payments")
          .select("id, order_id, external_payment_id, status")
          .eq("external_payment_id", paymentId)
          .maybeSingle();
        if (!concurrentPayment) throw new Error(`Unable to persist payment: ${insertError.message}`);
      }
    } else {
      const { error: updatePaymentError } = await supabase
        .from("payments")
        .update({
          status: payment.status,
          amount: payment.transaction_amount,
          currency: payment.currency_id,
          paid_at: payment.date_approved,
          updated_at: new Date().toISOString()
        })
        .eq("id", existingPayment.id);
      if (updatePaymentError) throw new Error(`Unable to update payment: ${updatePaymentError.message}`);
    }

    const orderStatus = this.getOrderStatus(payment.status);
    const updateOrderPayload: Record<string, string> = {
      payment_status: payment.status,
      status: orderStatus,
      updated_at: new Date().toISOString()
    };

    if (payment.status === "approved") {
      updateOrderPayload.status = "paid";
      updateOrderPayload.payment_status = "approved";
      updateOrderPayload.paid_at = new Date().toISOString();
    }

    // Para una aprobación, la condición `paid_at IS NULL` actúa como guardia
    // atómica: si dos llamadas concurrentes (dos entregas del mismo webhook,
    // o una carrera entre el insert y el update de "payments" de arriba)
    // intentan aprobar la misma orden, sólo una de ellas logra actualizar
    // la fila. Eso es lo que determina, de forma confiable, quién "ganó" y
    // por lo tanto quién debe disparar el email y el descuento de stock —
    // en vez de basarnos en si esta llamada insertó o actualizó el registro
    // de "payments", que no garantiza exclusividad ante una carrera real.
    let orderUpdateQuery = supabase.from("orders").update(updateOrderPayload).eq("id", order.id);
    if (payment.status === "approved") {
      orderUpdateQuery = orderUpdateQuery.is("paid_at", null);
    }

    const { data: updatedOrderRows, error: updateOrderError } = await orderUpdateQuery.select("id");
    if (updateOrderError) throw new Error(`Unable to update order: ${updateOrderError.message}`);

    const wonApprovalRace = payment.status === "approved" && (updatedOrderRows?.length ?? 0) > 0;

    if (wonApprovalRace) {
      await sendMercadoPagoOrderConfirmationEmail(this.env, order.id, payment);
      const { error: stockError } = await supabase.rpc("decrement_order_stock", {
        p_order_id: order.id
      });
      if (stockError) throw new Error(`Unable to decrement stock: ${stockError.message}`);
    }

    console.log(JSON.stringify({
      event: "mercadopago_payment_processed",
      request_id: requestId,
      payment_id: paymentId,
      external_reference: externalReference,
      payment_status: payment.status,
      update_result: payment.status === "approved" ? "approved_order_updated" : "order_updated"
    }));
  }

  private getOrderStatus(status: MercadoPagoPaymentStatus): "pending" | "paid" | "cancelled" {
    if (status === "approved") return "paid";
    if (status === "rejected" || status === "cancelled" || status === "refunded" || status === "charged_back") {
      return "cancelled";
    }
    return "pending";
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
