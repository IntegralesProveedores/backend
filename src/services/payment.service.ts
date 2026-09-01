import { getSupabase } from "./db";
import { getPricingConfig } from "./settings";
import { calculatePriceV2, calculateOrderCommission, TaxRule } from "../lib/pricing";
import { resolveVolumeDiscountFactor } from "../lib/products";
import {
  MercadoPagoPayer,
  MercadoPagoPaymentResponse,
  MercadoPagoPreferenceItem,
  MercadoPagoPreferenceRequest,
  MercadoPagoPaymentStatus
} from "../lib/mercadopago.types";
import { MercadoPagoService } from "./mercadopago.service";

export interface PaymentCustomerInput {
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

export interface ShippingAddressInput {
  recipient_name: string;
  postal_code: string;
  province: string;
  locality: string;
  county: string;
  street: string;
  street_number: string;
  floor: string;
  apartment: string;
  country: string;
  observations?: string;
}

export interface ShippingInput {
  method: "pickup" | "delivery" | "coordinar";
  address?: ShippingAddressInput;
}

export interface ShippingBox {
  boxModelId: string;
  boxModelName: string;
  widthCm: number;
  lengthCm: number;
  heightCm: number;
  weightKg: number;
  count: number;
  unitPriceArs: number;
}

export interface ProductGroup {
  product_id: string;
  units: number;
}

interface ShippingResolution {
  zone: string;
  priceArs: number;
  boxes: ShippingBox[];
  boxCount: number;
}

export interface CreatePaymentInput {
  items: PaymentItemInput[];
  customer: PaymentCustomerInput;
  shipping: ShippingInput;
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
  id: string;
  name: string;
  cost_usd: number | string;
  units_per_pack_master: number | string;
  cost_currency?: "ARS" | "USD";
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

interface OrderConfirmationOrderRow {
  id: string;
  total_amount: number | string;
  shipping_amount: number | string;
  exchange_rate_used: number | string;
}

interface OrderConfirmationProductRow {
  name: string;
}

interface OrderConfirmationVariantRow {
  sku: string;
  products: OrderConfirmationProductRow | OrderConfirmationProductRow[] | null;
}

interface OrderConfirmationItemRow {
  product_variant_id: string;
  quantity: number | string;
  unit_price: number | string;
  product_variants: OrderConfirmationVariantRow | OrderConfirmationVariantRow[] | null;
}

interface OrderConfirmationCustomerRow {
  full_name: string;
  email: string;
  tax_id: string | null;
  phone_area_code: string | null;
  phone_number: string | null;
}

/** Fila de order_addresses usada para armar la sección "Envío" del mail de confirmación */
interface OrderConfirmationAddressRow {
  shipping_method: "pickup" | "delivery" | "coordinar" | null;
  recipient_name: string | null;
  postal_code: string | null;
  province: string | null;
  locality: string | null;
  county: string | null;
  street: string | null;
  street_number: string | null;
  floor: string | null;
  apartment: string | null;
}

export class PaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentInputError";
  }
}

interface PaymentQuoteItem extends MercadoPagoPreferenceItem {
  product_id: string;
  sku: string;
  product_name: string;
  units_per_pack: number;
  units_per_pack_master: number;
  price_usd: number;
  subtotal_ars: number;
  subtotal_usd: number;
}

interface PaymentQuote {
  items: PaymentQuoteItem[];
  subtotal_ars: number;
  subtotal_usd: number;
  shipping_price_ars: number;
  exchange_rate: number;
}

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const isValidEmail = (value: unknown): value is string => {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
};

export async function resolveShippingBoxPlan(
  env: Env,
  zoneName: string,
  productGroups: ProductGroup[],
  deliverySpeed = "standard"
): Promise<{ boxes: ShippingBox[]; totalPriceArs: number }> {
  if (productGroups.length === 0) return { boxes: [], totalPriceArs: 0 };

  const supabase = getSupabase(env);
  const { shippingPriceBufferPercentage } = await getPricingConfig(env);
  const bufferFactor = 1 + shippingPriceBufferPercentage / 100;
  const result = { boxes: [] as ShippingBox[], totalPriceArs: 0 };
  for (const group of productGroups) {
    if (group.units <= 0) continue;
    const { data: assignments, error: assignmentsError } = await supabase
      .from("pricing_shipping_box_assignments")
      .select("box_model_id, min_quantity, max_quantity")
      .eq("product_id", group.product_id)
      .eq("active", true);
    if (assignmentsError) throw new Error(`Unable to load shipping box rules: ${assignmentsError.message}`);
    if (!assignments?.length) throw new Error(`No shipping box rules found for product ${group.product_id}`);

    const modelIds = [...new Set(assignments.map((a: any) => String(a.box_model_id)))];
    const [ratesResult, modelsResult] = await Promise.all([
      supabase.from("pricing_shipping_rates").select("price_ars, box_model_id")
        .eq("zone_name", zoneName).eq("delivery_speed", deliverySpeed).eq("active", true)
        .in("box_model_id", modelIds),
      supabase.from("pricing_shipping_box_models").select("id, name, width_cm, length_cm, height_cm, weight_kg")
        .eq("active", true).in("id", modelIds)
    ]);
    if (ratesResult.error || modelsResult.error) {
      throw new Error(`Unable to load shipping boxes and rates: ${ratesResult.error?.message ?? modelsResult.error?.message}`);
    }
    const rates = new Map((ratesResult.data ?? []).map((r: any) => [String(r.box_model_id), Number(r.price_ars)]));
    const models = new Map((modelsResult.data ?? []).map((m: any) => [String(m.id), m]));
    const boxes = assignments.flatMap((assignment: any) => {
      const id = String(assignment.box_model_id);
      const model = models.get(id);
      const minQuantity = Number(assignment.min_quantity);
      const maxQuantity = Number(assignment.max_quantity);
      const capacity = Number(assignment.max_quantity);
      const price = rates.get(id);
      return model && Number.isFinite(minQuantity) && Number.isFinite(capacity) && capacity > 0 && price !== undefined
        ? [{ boxModelId: id, minQuantity, maxQuantity: capacity, capacity, priceArs: Math.round(price * bufferFactor), name: String(model.name), widthCm: Number(model.width_cm), lengthCm: Number(model.length_cm), heightCm: Number(model.height_cm), weightKg: Number(model.weight_kg) }]
        : [];
    });
    if (!boxes.length) throw new Error(`No active shipping rates found for zone "${zoneName}" and delivery speed "${deliverySpeed}"`);
    const largestBox = boxes.reduce((largest, box) => box.maxQuantity > largest.maxQuantity ? box : largest);
    const counts = new Map<string, number>();
    let remainingUnits = group.units;
    let totalPrice = 0;
    while (remainingUnits > 0) {
      const matchingBox = boxes.find(box => remainingUnits >= box.minQuantity && remainingUnits <= box.maxQuantity);
      const box = matchingBox ?? (remainingUnits > largestBox.maxQuantity ? largestBox : null);
      if (!box) throw new Error(`Unable to build a shipping box plan for ${group.units} units`);
      counts.set(box.boxModelId, (counts.get(box.boxModelId) ?? 0) + 1);
      totalPrice += box.priceArs;
      remainingUnits = matchingBox ? 0 : remainingUnits - largestBox.maxQuantity;
    }
    for (const box of boxes) if (counts.has(box.boxModelId)) {
      const existing = result.boxes.find(b => b.boxModelId === box.boxModelId);
      if (existing) existing.count += counts.get(box.boxModelId)!;
      else result.boxes.push({ boxModelId: box.boxModelId, boxModelName: box.name, widthCm: box.widthCm, lengthCm: box.lengthCm, heightCm: box.heightCm, weightKg: box.weightKg, count: counts.get(box.boxModelId)!, unitPriceArs: box.priceArs });
    }
    result.totalPriceArs += Math.round(totalPrice);
  }
  return result;
}


/** Extrae los 4 dígitos numéricos de un código postal, sea formato viejo (1428)
 *  o CPA completo (C1428BOB). Devuelve null si no encuentra 4 dígitos válidos. */
function extractPostalCodeDigits(rawPostalCode: string): string | null {
  const digits = (rawPostalCode ?? "").replace(/\D/g, "").slice(0, 4);
  return /^\d{4}$/.test(digits) ? digits : null;
}

export async function resolveShippingRate(
  env: Env,
  postalCode: string,
  productGroups: ProductGroup[]
): Promise<ShippingResolution | null> {
  const supabase = getSupabase(env);
  const normalizedPostalCode = extractPostalCodeDigits(postalCode);
  if (!normalizedPostalCode) return null;

  // 1) Fuente de verdad: buscar la provincia real por código postal exacto
  const { data: postalData, error: postalError } = await supabase
    .from("postal_codes_ar")
    .select("province")
    .eq("postal_code", normalizedPostalCode)
    .limit(1)
    .maybeSingle();

  if (postalError) throw new Error(`Unable to resolve province for postal code: ${postalError.message}`);

  let zoneName = postalData?.province ?? null;

  // 2) Fallback: si el código postal no está cargado en postal_codes_ar,
  //    usamos el esquema anterior por rango (CABA_PBA / RESTO_PAIS) para no romper el checkout.
  if (!zoneName) {
    const cp = Number.parseInt(normalizedPostalCode, 10);
    const { data: zoneData, error: zoneError } = await supabase
      .from("pricing_shipping_zones")
      .select("zone_name")
      .eq("active", true)
      .lte("postal_code_from", cp)
      .gte("postal_code_to", cp)
      .limit(1)
      .maybeSingle();

    if (zoneError) throw new Error(`Unable to resolve shipping zone: ${zoneError.message}`);
    zoneName = zoneData?.zone_name ?? null;
  }

  if (!zoneName) return null;

  const boxPlan = await resolveShippingBoxPlan(env, String(zoneName), productGroups);

  return {
    zone: String(zoneName),
    priceArs: boxPlan.totalPriceArs,
    boxes: boxPlan.boxes,
    boxCount: boxPlan.boxes.reduce((sum, box) => sum + box.count, 0)
  };
}


export async function getShippingPriceArs(
  env: Env,
  shipping: ShippingInput,
  productGroups: ProductGroup[]
): Promise<number> {
  if (shipping.method === "pickup" || shipping.method === "coordinar") return 0;
  if (!shipping.address?.postal_code) return 0;
  const resolution = await resolveShippingRate(env, shipping.address.postal_code, productGroups);
  return resolution?.priceArs ?? 0;
}

export async function createOrderRecord(
  env: Env,
  customer: PaymentCustomerInput,
  items: Array<{
    variant_id: string;
    product_id: string;
    sku: string;
    product_name: string;
    quantity: number;
    units_per_pack: number;
    units_per_pack_master: number;
    unit_price: number;
  }>,
  totalArs: number,
  exchangeRate: number,
  externalReference: string,
  source: "mercadopago" | "manual",
  shipping: ShippingInput,
  paymentMethod: string,
  paymentCommissionPercentage: number,
  paymentCommissionAmount: number
): Promise<{ id: string }> {
  const supabase = getSupabase(env);
  const productGroups = Array.from(items.reduce((groups, item) => {
    groups.set(item.product_id, (groups.get(item.product_id) ?? 0) + item.quantity * item.units_per_pack);
    return groups;
  }, new Map<string, number>()), ([product_id, units]) => ({ product_id, units }));
  const shippingAmount = await getShippingPriceArs(env, shipping, productGroups);
  const totalAmount = totalArs + shippingAmount;
  const paymentStatusBySource: Record<"mercadopago" | "manual", "pending"> = {
    mercadopago: "pending",
    manual: "pending"
  };
  const { data, error } = await supabase
    .from("orders")
    .insert({
      customer_email: customer.email,
      subtotal_amount: totalArs,
      shipping_amount: shippingAmount,
      total_amount: totalArs + shippingAmount + paymentCommissionAmount,
      payment_method: paymentMethod,
      payment_commission_percentage: paymentCommissionPercentage,
      payment_commission_amount: paymentCommissionAmount,
      exchange_rate_used: exchangeRate,
      status: "pending",
      payment_status: paymentStatusBySource[source],
      shipping_status: "pending",
      external_reference: externalReference
    })
    .select("id")
    .single();

  if (error || !data) throw new Error(`Unable to create order: ${error?.message ?? "unknown error"}`);
  const order = data as unknown as { id: string };

  try {
    const itemRows = items.map(item => ({
      order_id: order.id,
      product_variant_id: item.variant_id,
      quantity: item.quantity,
      unit_price: item.unit_price
    }));
    const address = shipping.method === "delivery" ? shipping.address! : undefined;
    const [itemsResult, customerResult, addressResult] = await Promise.all([
      supabase.from("order_items").insert(itemRows),
      supabase.from("order_customers").insert({
        order_id: order.id,
        customer_type: customer.cuit ? "business" : "consumer",
        full_name: customer.nombre,
        tax_id: customer.cuit,
        tax_condition: "Consumidor Final",
        email: customer.email,
        phone_area_code: customer.codigoArea,
        phone_number: customer.celular
      }),
      supabase.from("order_addresses").insert({
        order_id: order.id,
        // TODO: agregar 'coordinar' al CHECK de order_addresses.shipping_method
        // mediante una migración de Supabase antes de desplegar este método.
        shipping_method: shipping.method,
        // Para pickup/coordinar no hay dirección cargada, pero la columna es
        // NOT NULL: usamos el nombre del comprador como destinatario por
        // defecto (siempre es la misma persona, ver checkout sin checkbox de
        // "mismo destinatario").
        recipient_name: address?.recipient_name ?? customer.nombre ?? null,
        postal_code: address?.postal_code ?? null,
        province: address?.province ?? null,
        locality: address?.locality ?? null,
        county: address?.county ?? null,
        street: address?.street ?? null,
        street_number: address?.street_number ?? null,
        floor: address?.floor ?? null,
        apartment: address?.apartment ?? null,
        country: address?.country ?? null
        ,observations: address?.observations ?? null
      })
    ]);

    if (itemsResult.error || customerResult.error || addressResult.error) {
      throw new Error(itemsResult.error?.message ?? customerResult.error?.message ?? addressResult.error?.message ?? "Unable to persist order details");
    }
  } catch (error) {
    await supabase.from("orders").delete().eq("id", order.id);
    throw error;
  }

  return order;
}

export class PaymentService {
  private readonly mercadoPago: MercadoPagoService;

  constructor(private readonly env: Env) {
    this.mercadoPago = new MercadoPagoService(env.MP_ACCESS_TOKEN);
  }

  async createCheckout(input: CreatePaymentInput): Promise<{ init_point: string }> {
    this.validateInput(input);

    const supabase = getSupabase(this.env);
    const quote = await this.buildQuote(input);
    const pricingConfig = await getPricingConfig(this.env);
    const commission = calculateOrderCommission(
      quote.subtotal_ars - quote.shipping_price_ars,
      quote.shipping_price_ars,
      "mercadopago",
      pricingConfig.paymentCommissionPercentage
    );
    const externalReference = crypto.randomUUID();
    const createdOrder = await createOrderRecord(
      this.env,
      input.customer,
      quote.items.map(item => ({
        variant_id: item.id,
        product_id: item.product_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        units_per_pack: item.units_per_pack,
        units_per_pack_master: item.units_per_pack_master,
        unit_price: item.unit_price
      })),
      quote.subtotal_ars - quote.shipping_price_ars,
      quote.exchange_rate,
      externalReference,
      "mercadopago",
      input.shipping,
      "mercadopago",
      commission.paymentCommissionPercentage,
      commission.paymentCommissionAmount
    );

    try {
      const preference = await this.mercadoPago.createPreference(
        this.buildPreference(input, quote, externalReference, createdOrder.id, commission.paymentCommissionAmount)
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
      await this.sendOrderConfirmationEmail(order.id, payment);
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

  /**
   * Arma el bloque HTML de la sección "Envío" para el mail de confirmación.
   * Si no hay fila de dirección (o el método es 'pickup'), muestra el texto de
   * coordinación por WhatsApp; si es 'delivery', muestra la dirección completa.
   *
   * TODO: unificar este template con el equivalente del frontend
   * (checkout.component.ts -> generarSeccionEnvio) en un paquete compartido
   * cuando se pueda — hoy corren en runtimes distintos (Cloudflare Worker vs
   * browser) y se duplica el HTML a propósito.
   */
  private buildEnvioSectionHtml(
    address: OrderConfirmationAddressRow | null,
    shippingAmountArs: number,
    escapeHtml: (value: unknown) => string,
    formatAmount: (value: number | string) => string
  ): string {
    if (address?.shipping_method === "coordinar") {
      return `
        <div style="margin-top: 25px; padding: 18px; background-color: #f0f7ff; border-radius: 6px; border-left: 4px solid #2b5e2b;">
          <p style="margin: 0 0 10px; color: #2b5e2b; font-weight: bold; font-size: 15px;">
            💬 Coordinemos tu envío
          </p>
          <p style="margin: 0 0 10px; font-size: 13px; color: #444; line-height: 1.5;">
            Escribinos por WhatsApp al <strong>+54 9 11 3022-6565</strong> para coordinar
            el método de envío (transporte, micro o expreso), el costo y los tiempos
            según tu localidad.
          </p>
          <p style="margin: 0; font-size: 12px; color: #777;">
            Te respondemos de lunes a jueves de 10 a 14 hs. Los mensajes fuera de ese
            horario se responden el día hábil siguiente dentro del horario indicado.
          </p>
          <p style="margin: 10px 0 0; font-size: 13px; color: #444;">
            El costo de envío se coordina por WhatsApp según transporte y destino.
          </p>
        </div>
      `;
    }

    if (!address || address.shipping_method === "pickup") {
      return `
        <div style="margin-top: 25px; padding: 18px; background-color: #f0f7ff; border-radius: 6px; border-left: 4px solid #2b5e2b;">
          <p style="margin: 0 0 10px; color: #2b5e2b; font-weight: bold; font-size: 15px;">
            📦 Coordiná tu retiro
          </p>
          <p style="margin: 0 0 10px; font-size: 13px; color: #444; line-height: 1.5;">
            Escribinos por WhatsApp al <strong>+54 9 11 3022-6565</strong> para coordinar
            día, horario y punto de retiro. Podés retirar en
            <strong>Portela 875, Flores, CABA</strong> o en
            <strong>Roosevelt 1935, Belgrano, CABA</strong>, según disponibilidad.
          </p>
          <p style="margin: 0; font-size: 12px; color: #777;">
            Atendemos de lunes a jueves de 10 a 14 hs. Los mensajes enviados fuera de
            ese horario se responden el día hábil siguiente dentro del horario indicado.
          </p>
        </div>
      `;
    }

    const direccionCompleta = [
      `${escapeHtml(address.street)} ${escapeHtml(address.street_number)}`,
      address.floor ? `Piso ${escapeHtml(address.floor)}` : null,
      address.apartment ? `Depto ${escapeHtml(address.apartment)}` : null
    ].filter(Boolean).join(", ");

    return `
      <div style="margin-top: 25px;">
        <h3 style="color: #2b5e2b; font-size: 15px; margin-bottom: 10px;">Dirección de envío</h3>
        <table width="100%" style="border-collapse: collapse; font-size: 13px;">
          <tr>
            <td style="padding: 4px 0; color: #666; width: 140px;">Destinatario:</td>
            <td style="padding: 4px 0; color: #333;">${escapeHtml(address.recipient_name)}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #666;">Dirección:</td>
            <td style="padding: 4px 0; color: #333;">${direccionCompleta}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #666;">Localidad:</td>
            <td style="padding: 4px 0; color: #333;">${escapeHtml(address.locality)}${address.county ? ` (${escapeHtml(address.county)})` : ""}</td>
          </tr>
          <tr>
            <td style="padding: 4px 0; color: #666;">Provincia:</td>
            <td style="padding: 4px 0; color: #333;">${escapeHtml(address.province)}</td>
          </tr>
        <tr>
          <td style="padding: 4px 0; color: #666;">Código Postal:</td>
          <td style="padding: 4px 0; color: #333;">${escapeHtml(address.postal_code)}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #666;">Costo de envío:</td>
          <td style="padding: 4px 0; color: #333;">$${formatAmount(shippingAmountArs)}</td>
        </tr>
        </table>
      </div>
    `;
  }

  private async sendOrderConfirmationEmail(
    orderId: string,
    payment: MercadoPagoPaymentResponse
  ): Promise<void> {
    try {
      const supabase = getSupabase(this.env);
      const [orderResult, itemsResult, customerResult, addressResult] = await Promise.all([
        supabase
          .from("orders")
          .select("id, total_amount, shipping_amount, exchange_rate_used")
          .eq("id", orderId)
          .single(),
        supabase
          .from("order_items")
          .select(`
            product_variant_id,
            quantity,
            unit_price,
            product_variants (
              sku,
              products (
                name
              )
            )
          `)
          .eq("order_id", orderId),
        supabase
          .from("order_customers")
          .select("full_name, email, tax_id, phone_area_code, phone_number")
          .eq("order_id", orderId)
          .single(),
        supabase
          .from("order_addresses")
          .select("recipient_name, postal_code, province, locality, county, street, street_number, floor, apartment, shipping_method")
          .eq("order_id", orderId)
          .maybeSingle()
      ]);

      if (orderResult.error || !orderResult.data) {
        throw new Error(`Unable to load order confirmation data: ${orderResult.error?.message ?? "order not found"}`);
      }
      if (itemsResult.error) {
        throw new Error(`Unable to load order items for email: ${itemsResult.error.message}`);
      }
      if (customerResult.error || !customerResult.data) {
        throw new Error(`Unable to load order customer for email: ${customerResult.error?.message ?? "customer not found"}`);
      }
      if (addressResult.error) {
        // No bloqueamos el envío del mail por esto: preferimos mandar el mail
        // sin la sección de envío (fallback a "pickup"/coordinación) antes que
        // no mandar nada.
        console.error("Unable to load order_addresses for confirmation email:", addressResult.error.message);
      }

      const order = orderResult.data as unknown as OrderConfirmationOrderRow;
      const items = (itemsResult.data ?? []) as unknown as OrderConfirmationItemRow[];
      const customer = customerResult.data as unknown as OrderConfirmationCustomerRow;
      const address = (addressResult.data ?? null) as unknown as OrderConfirmationAddressRow | null;
      const escapeHtml = (value: unknown): string => String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
      const formatAmount = (value: number | string): string => Number(value).toFixed(2);
      const getVariant = (value: OrderConfirmationVariantRow | OrderConfirmationVariantRow[] | null) =>
        Array.isArray(value) ? value[0] : value;
      const getProduct = (value: OrderConfirmationProductRow | OrderConfirmationProductRow[] | null) =>
        Array.isArray(value) ? value[0] : value;
      const itemsHtml = items.map(item => {
        const variant = getVariant(item.product_variants);
        const product = getProduct(variant?.products ?? null);
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unit_price);
        return `<tr><td>${escapeHtml(product?.name ?? "")}</td><td>${escapeHtml(variant?.sku ?? "")}</td><td>${quantity}</td><td>${formatAmount(unitPrice)}</td><td>${formatAmount(unitPrice * quantity)}</td></tr>`;
      }).join("");
      const phone = [customer.phone_area_code, customer.phone_number].filter(Boolean).join(" ");
      const envioHtml = this.buildEnvioSectionHtml(address, Number(order.shipping_amount), escapeHtml, formatAmount);
      const mensajeHtml = `
        <h2>Confirmación de pedido</h2>
        <h3>Cliente</h3>
        <p><strong>Nombre:</strong> ${escapeHtml(customer.full_name)}<br>
        <strong>Email:</strong> ${escapeHtml(customer.email)}<br>
        <strong>CUIT:</strong> ${escapeHtml(customer.tax_id)}<br>
        <strong>Teléfono:</strong> ${escapeHtml(phone)}</p>
        <h3>Items</h3>
        <table border="1" cellpadding="6" cellspacing="0">
          <thead><tr><th>Nombre</th><th>SKU</th><th>Cantidad</th><th>Precio unitario</th><th>Subtotal</th></tr></thead>
          <tbody>${itemsHtml}</tbody>
        </table>
        ${envioHtml}
        <p><strong>Total:</strong> ${formatAmount(order.total_amount)} ARS<br>
        <strong>Cotización usada:</strong> ${formatAmount(order.exchange_rate_used)}</p>
        <h3>Pago Mercado Pago</h3>
        <p><strong>ID:</strong> ${escapeHtml(payment.id)}<br>
        <strong>Estado:</strong> ${escapeHtml(payment.status)}<br>
        <strong>Fecha de aprobación:</strong> ${escapeHtml(payment.date_approved)}</p>
      `.trim();

      const response = await fetch("https://api.emailjs.com/api/v1.0/email/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          service_id: this.env.EMAILJS_SERVICE_ID,
          template_id: this.env.EMAILJS_TEMPLATE_ID,
          user_id: this.env.EMAILJS_PUBLIC_KEY,
          accessToken: this.env.EMAILJS_PRIVATE_KEY,
          template_params: {
            to_email: customer.email,
            to_name: customer.full_name,
            name: customer.full_name,
            email: customer.email,
            reply_to: customer.email,
            telefono: phone,
            order_id: orderId,
            mensaje_html: mensajeHtml
          }
        })
      });

      if (!response.ok) {
        throw new Error(`EmailJS request failed with status ${response.status}: ${await response.text()}`);
      }
    } catch (error) {
      console.error("Unable to send order confirmation email", error);
    }
  }

  private validateInput(input: CreatePaymentInput): void {
    if (!input || !Array.isArray(input.items) || input.items.length === 0) {
      throw new PaymentInputError("items must be a non-empty array");
    }

    if (!input.customer || !isValidEmail(input.customer.email)) {
      throw new PaymentInputError("customer.email is invalid");
    }

    validateShippingInput(input.shipping);

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
    let totalEquivalentPacks = 0;

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
            id,
            name,
            cost_usd,
            units_per_pack_master,
            cost_currency
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
      totalEquivalentPacks += (presentationQuantity * inputItem.quantity) / unitsPerPackMaster;
      const equivalentPacks = (presentationQuantity * inputItem.quantity) / unitsPerPackMaster;
      const discountFactor = resolveVolumeDiscountFactor(equivalentPacks, discounts);
      const pricing = calculatePriceV2({
        cost_usd_master: round2(Number(product.cost_usd) / discountFactor),
        cost_currency: product.cost_currency,
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
        product_id: String((product as ProductRow).id),
        sku: variant.sku,
        title: product.name,
        description: `SKU ${variant.sku}`,
        quantity: inputItem.quantity,
        currency_id: "ARS",
        unit_price: priceArs,
        product_name: product.name,
        units_per_pack: presentationQuantity,
        units_per_pack_master: unitsPerPackMaster,
        price_usd: priceUsd,
        subtotal_ars: itemSubtotalArs,
        subtotal_usd: itemSubtotalUsd
      });
    }

    const productGroups = Array.from(items.reduce((groups, item) => {
      groups.set(item.product_id, (groups.get(item.product_id) ?? 0) + item.quantity * item.units_per_pack);
      return groups;
    }, new Map<string, number>()), ([product_id, units]) => ({ product_id, units }));
    const shippingArs = await getShippingPriceArs(this.env, input.shipping, productGroups);

    return {
      items,
      subtotal_ars: subtotalArs + shippingArs,
      subtotal_usd: round2(subtotalUsd),
      shipping_price_ars: shippingArs,
      exchange_rate: pricingConfig.exchangeRate
    };
  }

  private buildPreference(
    input: CreatePaymentInput,
    quote: PaymentQuote,
    externalReference: string,
    orderId: string,
    paymentCommissionAmount = 0
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
        ...quote.items.map(({ product_id: _productId, sku: _sku, product_name: _productName, units_per_pack: _unitsPerPack, units_per_pack_master: _unitsPerPackMaster, price_usd: _priceUsd, subtotal_ars: _subtotalArs, subtotal_usd: _subtotalUsd, ...item }) => item),
        ...(quote.shipping_price_ars > 0 ? [{
          id: "shipping",
          title: "Costo de envío",
          description: "Envío a domicilio",
          quantity: 1,
          currency_id: "ARS" as const,
          unit_price: quote.shipping_price_ars
        }] : []),
        ...(paymentCommissionAmount > 0 ? [{
          id: "payment-commission",
          title: "Comisión de pago",
          description: "Mercado Pago",
          quantity: 1,
          currency_id: "ARS" as const,
          unit_price: paymentCommissionAmount
        }] : [])
      ],
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
    },
    shipping: parseShippingInput(record.shipping)
  };
}

export function parseShippingInput(value: unknown): ShippingInput {
  if (!value || typeof value !== "object") throw new PaymentInputError("shipping is required");
  const record = value as Record<string, unknown>;
  const method = record.method;
  if (method !== "pickup" && method !== "delivery" && method !== "coordinar") {
    throw new PaymentInputError("shipping.method must be pickup, delivery, or coordinar");
  }

  if (method === "pickup" || method === "coordinar") return { method };
  if (!record.address || typeof record.address !== "object") {
    throw new PaymentInputError("shipping.address is required for delivery");
  }

  const address = record.address as Record<string, unknown>;
  return {
    method,
    address: {
      recipient_name: String(address.recipient_name ?? "").trim(),
      postal_code: String(address.postal_code ?? "").trim(),
      province: String(address.province ?? "").trim(),
      locality: String(address.locality ?? "").trim(),
      county: String(address.county ?? "").trim(),
      street: String(address.street ?? "").trim(),
      street_number: String(address.street_number ?? "").trim(),
      floor: String(address.floor ?? "").trim(),
      apartment: String(address.apartment ?? "").trim(),
      country: String(address.country ?? "").trim(),
      observations: String(address.observations ?? "").trim()
    }
  };
}

export function validateShippingInput(shipping: ShippingInput): void {
  if (!shipping || (shipping.method !== "pickup" && shipping.method !== "delivery" && shipping.method !== "coordinar")) {
    throw new PaymentInputError("shipping.method must be pickup, delivery, or coordinar");
  }
  if (shipping.method === "delivery") {
    const address = shipping.address;
    const province = address?.province.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isCaba = province === "ciudad autonoma de buenos aires" || province === "caba";
    if (!address || !address.street || !address.street_number || !address.postal_code || !address.province || (!isCaba && !address.locality)) {
      throw new PaymentInputError("Delivery shipping requires street, street_number, postal_code, province, and locality outside CABA");
    }
  }
}
