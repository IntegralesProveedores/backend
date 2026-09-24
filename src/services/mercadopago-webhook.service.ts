import { getSupabase } from "./db";
import { MercadoPagoPaymentResponse, MercadoPagoPaymentStatus } from "../lib/mercadopago.types";
import { MercadoPagoService } from "./mercadopago.service";
import { logEvent } from "../lib/log";
import { sendMercadoPagoOrderConfirmationEmail } from "./email/order-confirmation-templates";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Procesa el pago que Mercado Pago notifica por webhook: valida la firma,
//           consulta el pago, lo registra, actualiza la orden y, si es la primera
//           aprobación, manda el mail y descuenta el stock.
// POR QUÉ:  Antes compartía clase con la creación del checkout
//           (mercadopago-checkout.service.ts): son dos casos de uso con motivos de
//           cambio distintos.
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

export class MercadoPagoWebhookService {
  private readonly mercadoPago: MercadoPagoService;

  constructor(private readonly env: Env) {
    this.mercadoPago = new MercadoPagoService(env.MP_ACCESS_TOKEN);
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
      logEvent("log", "mercadopago_payment_idempotent_skip", {
        mp_request_id: requestId,
        payment_id: String(payment.id),
        payment_status: payment.status,
        update_result: "already_approved"
      });
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

    logEvent("log", "mercadopago_payment_processed", {
      mp_request_id: requestId,
      payment_id: paymentId,
      payment_status: payment.status,
      update_result: payment.status === "approved" ? "approved_order_updated" : "order_updated"
    });
  }

  private getOrderStatus(status: MercadoPagoPaymentStatus): "pending" | "paid" | "cancelled" {
    if (status === "approved") return "paid";
    if (status === "rejected" || status === "cancelled" || status === "refunded" || status === "charged_back") {
      return "cancelled";
    }
    return "pending";
  }
}
