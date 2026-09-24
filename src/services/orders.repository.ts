import { getSupabase } from "./db";
import { PaymentCustomerInput, ShippingInput } from "../lib/payment-input.validation";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Persistencia de la orden y sus filas relacionadas
//           (order_items, order_customers, order_addresses).
// POR QUÉ:  Antes vivía mezclada dentro de payment.service.ts junto
//           con envío, email y checkout de MP.
// ─────────────────────────────────────────────────────────────

/** Ya existe una orden con ese idempotency_key: dos requests del mismo intento
 *  (doble click, reintento de red) chocaron contra la restricción única de la
 *  tabla casi al mismo tiempo. El llamador debe tratar esto como éxito, no error. */
export class DuplicateOrderError extends Error {
  constructor(public readonly orderId: string, public readonly externalReference: string) {
    super(`Duplicate order for idempotency_key (order ${orderId})`);
    this.name = "DuplicateOrderError";
  }
}

/** La idempotency_key ya se usó para un pedido distinto (otros ítems) o para una orden que
 *  se canceló: no es un reintento del mismo intento. El frontend tiene que mandar una key nueva. */
export class IdempotencyConflictError extends Error {
  constructor(public readonly externalReference: string) {
    super(`idempotency_key already used by a different or cancelled order (${externalReference})`);
    this.name = "IdempotencyConflictError";
  }
}

export interface IdempotentOrder {
  id: string;
  external_reference: string;
  status?: string | null;
  order_items?: Array<{ product_variant_id: string; quantity: number }>;
}

export async function findOrderByIdempotencyKey(
  env: Env,
  idempotencyKey: string
): Promise<IdempotentOrder | null> {
  const { data, error } = await getSupabase(env)
    .from("orders")
    .select("id, external_reference, status, order_items(product_variant_id, quantity)")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();
  if (error) throw new Error(`Unable to check idempotency_key: ${error.message}`);
  return data as IdempotentOrder | null;
}

function unitsByVariant(items: Array<{ variant_id: string; quantity: number }>): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item.variant_id, (map.get(item.variant_id) ?? 0) + Number(item.quantity));
  return map;
}

/**
 * ¿Es la misma orden que ya se creó con esta key? Solo si no está cancelada y tiene
 * exactamente los mismos ítems (presentación y cantidad). Si no, reusarla dejaría una
 * orden con los ítems viejos cobrando el total nuevo.
 */
export function isSameIdempotentOrder(
  existing: IdempotentOrder,
  requestItems: Array<{ variant_id: string; quantity: number }>
): boolean {
  if (existing.status === "cancelled") return false;
  const stored = unitsByVariant(
    (existing.order_items ?? []).map(i => ({ variant_id: i.product_variant_id, quantity: i.quantity }))
  );
  const requested = unitsByVariant(requestItems);
  if (stored.size !== requested.size) return false;
  for (const [variantId, quantity] of requested) {
    if (stored.get(variantId) !== quantity) return false;
  }
  return true;
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
  shipping: ShippingInput,
  shippingAmount: number,
  embalajeAmount: number,
  paymentMethod: string,
  paymentDiscountPercentage: number,
  paymentDiscountAmount: number,
  idempotencyKey?: string
): Promise<{ id: string }> {
  const supabase = getSupabase(env);
  const { data, error } = await supabase
    .from("orders")
    .insert({
      customer_email: customer.email,
      subtotal_amount: totalArs,
      shipping_amount: shippingAmount,
      // Solo para el registro: el embalaje ya está repartido dentro de totalArs
      // (precio de cada producto), no se vuelve a sumar acá.
      embalaje_amount: embalajeAmount,
      total_amount: totalArs + shippingAmount - paymentDiscountAmount,
      payment_method: paymentMethod,
      // El costo del medio de pago va dentro de los precios: ya no hay comisión aparte.
      payment_commission_percentage: 0,
      payment_commission_amount: 0,
      payment_discount_percentage: paymentDiscountPercentage,
      payment_discount_amount: paymentDiscountAmount,
      exchange_rate_used: exchangeRate,
      status: "pending",
      payment_status: "pending",
      shipping_status: "pending",
      external_reference: externalReference,
      idempotency_key: idempotencyKey ?? null
    })
    .select("id")
    .single();

  if (error || !data) {
    // 23505 = unique_violation: otra request con el mismo idempotency_key ganó la carrera.
    if (error?.code === "23505" && idempotencyKey) {
      const existing = await findOrderByIdempotencyKey(env, idempotencyKey);
      if (existing) throw new DuplicateOrderError(existing.id, existing.external_reference);
    }
    throw new Error(`Unable to create order: ${error?.message ?? "unknown error"}`);
  }
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
