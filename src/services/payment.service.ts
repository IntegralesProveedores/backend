import { getSupabase } from "./db";
import { getPricingConfig } from "./settings";
import { calculatePriceV2, TaxRule } from "../lib/pricing";
import { resolveVolumeDiscountFactor } from "../lib/products";
import {
  MercadoPagoPayer,
  MercadoPagoPaymentResponse,
  MercadoPagoPreferenceItem,
  MercadoPagoPreferenceRequest,
  MercadoPagoPaymentStatus
} from "../lib/mercadopago.types";
import { MercadoPagoService } from "./mercadopago.service";

interface PaymentCustomerInput {
  nombre: string;
  email: string;
  cuit: string;
  codigoArea: string;
  celular: string;
}

interface PaymentItemInput {
  variant_id: string;
  quantity: number;
}

export interface CreatePaymentInput {
  items: PaymentItemInput[];
  customer: PaymentCustomerInput;
}

interface PricingTaxRow {
  name: string;
  percentage: number | string;
  is_computable: boolean;
  is_active: boolean;
}

interface VolumeDiscountRow {
  min_quantity: number | string;
  factor: number | string;
}

interface ProductRow {
  name: string;
  cost_usd: number | string;
  units_per_pack_master: number | string;
}

interface VariantRow {
  id: string;
  sku: string;
  stock: number;
  units_per_pack: number | null;
  is_active: boolean;
  deleted_at: string | null;
  products: ProductRow | ProductRow[] | null;
}

interface CreatedOrderRow {
  id: string;
  external_reference: string;
}

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

export class PaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentInputError";
  }
}

interface PaymentQuoteItem extends MercadoPagoPreferenceItem {
  product_name: string;
  units_per_pack: number;
  price_usd: number;
  subtotal_ars: number;
  subtotal_usd: number;
}

interface PaymentQuote {
  items: PaymentQuoteItem[];
  subtotal_ars: number;
  subtotal_usd: number;
  exchange_rate: number;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const isValidEmail = (value: unknown): value is string => {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
};

export class PaymentService {
  private readonly mercadoPago: MercadoPagoService;

  constructor(private readonly env: Env) {
    this.mercadoPago = new MercadoPagoService(env.MP_ACCESS_TOKEN);
  }

  async createCheckout(input: CreatePaymentInput): Promise<{ init_point: string }> {
    this.validateInput(input);

    const supabase = getSupabase(this.env);
    const quote = await this.buildQuote(input);
    const externalReference = crypto.randomUUID();
    const createdOrder = await this.createPendingOrder(input, quote, externalReference);

    try {
      const preference = await this.mercadoPago.createPreference(
        this.buildPreference(input, quote, externalReference, createdOrder.id)
      );

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

    const { error: updateOrderError } = await supabase
      .from("orders")
      .update(updateOrderPayload)
      .eq("id", order.id);
    if (updateOrderError) throw new Error(`Unable to update order: ${updateOrderError.message}`);

    if (payment.status === "approved") {
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
    if (!input || !Array.isArray(input.items) || input.items.length === 0) {
      throw new PaymentInputError("items must be a non-empty array");
    }

    if (!input.customer || !isValidEmail(input.customer.email)) {
      throw new PaymentInputError("customer.email is invalid");
    }

    for (const item of input.items) {
      if (!item || typeof item.variant_id !== "string" || !item.variant_id || !isPositiveInteger(item.quantity)) {
        throw new PaymentInputError("Each item requires a valid variant_id and positive quantity");
      }
    }
  }

  private async buildQuote(input: CreatePaymentInput): Promise<PaymentQuote> {
    const supabase = getSupabase(this.env);
    const pricingConfig = await getPricingConfig(this.env);
    const [taxesResult, discountsResult] = await Promise.all([
      supabase
        .from("pricing_taxes")
        .select("name, percentage, is_computable, is_active")
        .eq("is_active", true),
      supabase
        .from("pricing_volume_discounts")
        .select("min_quantity, factor")
        .order("min_quantity", { ascending: false })
    ]);

    if (taxesResult.error) throw new Error(`Unable to load taxes: ${taxesResult.error.message}`);
    if (discountsResult.error) throw new Error(`Unable to load discounts: ${discountsResult.error.message}`);

    const taxes = ((taxesResult.data ?? []) as unknown as PricingTaxRow[]).map((tax): TaxRule => ({
      name: tax.name,
      percentage: Number(tax.percentage),
      is_computable: tax.is_computable,
      is_active: tax.is_active
    }));
    const discounts = ((discountsResult.data ?? []) as unknown as VolumeDiscountRow[]).map(discount => ({
      min: Number(discount.min_quantity),
      factor: Number(discount.factor)
    }));

    const items: PaymentQuoteItem[] = [];
    let subtotalArs = 0;
    let subtotalUsd = 0;

    for (const inputItem of input.items) {
      const { data, error } = await supabase
        .from("product_variants")
        .select(`
          id,
          sku,
          stock,
          units_per_pack,
          is_active,
          deleted_at,
          products (
            name,
            cost_usd,
            units_per_pack_master
          )
        `)
        .eq("id", inputItem.variant_id)
        .single();

      if (error || !data) throw new Error(`Variant not found: ${inputItem.variant_id}`);

      const variant = data as unknown as VariantRow;
      if (!variant.is_active || variant.deleted_at !== null) {
        throw new Error(`Variant not available: ${variant.sku}`);
      }
      if (variant.stock < inputItem.quantity) {
        throw new Error(`Insufficient stock for variant: ${variant.sku}`);
      }

      const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
      if (!product) throw new Error(`Product not found for variant: ${variant.sku}`);

      const unitsPerPackMaster = Number(product.units_per_pack_master) || 1;
      const presentationQuantity = Number(variant.units_per_pack) || 1;
      const equivalentPacks = (presentationQuantity * inputItem.quantity) / unitsPerPackMaster;
      const discountFactor = resolveVolumeDiscountFactor(equivalentPacks, discounts);
      const pricing = calculatePriceV2({
        cost_usd_master: round2(Number(product.cost_usd) / discountFactor),
        units_per_pack_master: unitsPerPackMaster,
        presentation_quantity: presentationQuantity,
        exchange_rate: pricingConfig.exchangeRate,
        rentability_percentage: pricingConfig.markups.minorista,
        taxes,
        embalaje_cost: pricingConfig.embalageCost
      });

      const priceArs = Math.round(pricing.precio_final_ars);
      const priceUsd = round2(priceArs / pricingConfig.exchangeRate);
      const itemSubtotalArs = priceArs * inputItem.quantity;
      const itemSubtotalUsd = round2(priceUsd * inputItem.quantity);
      subtotalArs += itemSubtotalArs;
      subtotalUsd += itemSubtotalUsd;

      items.push({
        id: variant.id,
        title: product.name,
        description: `SKU ${variant.sku}`,
        quantity: inputItem.quantity,
        currency_id: "ARS",
        unit_price: priceArs,
        product_name: product.name,
        units_per_pack: presentationQuantity,
        price_usd: priceUsd,
        subtotal_ars: itemSubtotalArs,
        subtotal_usd: itemSubtotalUsd
      });
    }

    return {
      items,
      subtotal_ars: subtotalArs,
      subtotal_usd: round2(subtotalUsd),
      exchange_rate: pricingConfig.exchangeRate
    };
  }

  private async createPendingOrder(
    input: CreatePaymentInput,
    quote: PaymentQuote,
    externalReference: string
  ): Promise<CreatedOrderRow> {
    const supabase = getSupabase(this.env);
    const { data, error } = await supabase
      .from("orders")
      .insert({
        customer_email: input.customer.email,
        subtotal_amount: quote.subtotal_ars,
        shipping_amount: 0,
        total_amount: quote.subtotal_ars,
        exchange_rate_used: quote.exchange_rate,
        status: "pending",
        payment_status: "pending",
        shipping_status: "pending",
        external_reference: externalReference
      })
      .select("id, external_reference")
      .single();

    if (error || !data) throw new Error(`Unable to create order: ${error?.message ?? "unknown error"}`);
    const order = data as unknown as CreatedOrderRow;

    try {
      const itemRows = quote.items.map(item => ({
        order_id: order.id,
        product_variant_id: item.id,
        quantity: item.quantity,
        unit_price: item.unit_price
      }));
      const [itemsResult, customerResult] = await Promise.all([
        supabase.from("order_items").insert(itemRows),
        supabase.from("order_customers").insert({
          order_id: order.id,
          customer_type: input.customer.cuit ? "business" : "consumer",
          full_name: input.customer.nombre,
          tax_id: input.customer.cuit,
          tax_condition: "Consumidor Final",
          email: input.customer.email,
          phone_area_code: input.customer.codigoArea,
          phone_number: input.customer.celular
        })
      ]);

      if (itemsResult.error || customerResult.error) {
        throw new Error(itemsResult.error?.message ?? customerResult.error?.message ?? "Unable to persist order details");
      }
    } catch (error) {
      await supabase.from("orders").delete().eq("id", order.id);
      throw error;
    }

    return order;
  }

  private buildPreference(
    input: CreatePaymentInput,
    quote: PaymentQuote,
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
      notification_url: "https://api.brotalia.com.ar/api/webhooks/mercadopago",
      back_urls: {
        success: `${appBaseUrl}/orden/exito`,
        pending: `${appBaseUrl}/orden/pendiente`,
        failure: `${appBaseUrl}/orden/error`
      },
      auto_return: "approved",
      binary_mode: false,
      statement_descriptor: "BROTALIA",
      expiration_date_from: now.toISOString(),
      expiration_date_to: expiration.toISOString(),
      payer,
      items: quote.items.map(({ product_name: _productName, units_per_pack: _unitsPerPack, price_usd: _priceUsd, subtotal_ars: _subtotalArs, subtotal_usd: _subtotalUsd, ...item }) => item),
      metadata: {
        order_id: orderId,
        external_reference: externalReference
      }
    };
  }
}

export function parseCreatePaymentInput(value: unknown): CreatePaymentInput {
  if (!value || typeof value !== "object") throw new PaymentInputError("Invalid request body");
  const record = value as Record<string, unknown>;
  const customer = record.customer;
  if (!customer || typeof customer !== "object") throw new PaymentInputError("customer is required");

  const customerRecord = customer as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) throw new PaymentInputError("items must be an array");

  return {
    items: items as PaymentItemInput[],
    customer: {
      nombre: String(customerRecord.nombre ?? "").trim(),
      email: String(customerRecord.email ?? "").trim(),
      cuit: String(customerRecord.cuit ?? "").trim(),
      codigoArea: String(customerRecord.codigoArea ?? "").trim(),
      celular: String(customerRecord.celular ?? "").trim()
    }
  };
}
