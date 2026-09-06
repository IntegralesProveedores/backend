import { getSupabase } from "./db";
import { PaymentCustomerInput, ShippingInput } from "../lib/payment-input.validation";
import { getShippingPriceArs } from "./shipping.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Persistencia de la orden y sus filas relacionadas
//           (order_items, order_customers, order_addresses).
// POR QUÉ:  Antes vivía mezclada dentro de payment.service.ts junto
//           con envío, email y checkout de MP.
// ─────────────────────────────────────────────────────────────

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
