import { getSupabase } from "../db";
import { getCachedTaxes } from "../settings";
import { PackagingBox, resolvePackagingPlan, resolveShippingRate } from "../shipping.service";
import { TaxRule } from "../../lib/pricing";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Carga los datos que necesitan los mails de confirmación: las cuentas para
//           transferir y, para Mercado Pago, la orden guardada (ítems, cliente, dirección,
//           impuestos y las cajas del embalaje, que no se guardan y se recalculan).
// POR QUÉ:  Separa las consultas (Supabase, cotizador de cajas) del armado del HTML, que
//           así queda como funciones puras en order-confirmation-templates.ts.
// ─────────────────────────────────────────────────────────────

export interface TransferAccountRow {
  bank_name: string;
  alias: string;
  cvu: string | null;
  cbu: string | null;
  account_number: string | null;
  account_holder_name: string;
  account_holder_tax_id: string;
}

/**
 * Cuentas para transferir que se muestran en el mail. Si la consulta falla se registra y
 * el mail sale igual, sin datos bancarios.
 */
export async function loadTransferAccounts(env: Env): Promise<TransferAccountRow[]> {
  const { data, error } = await getSupabase(env)
    .from("payment_transfer_info")
    .select("bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position")
    .eq("active", true)
    // El checkout (checkout.component.ts) solo muestra la cuenta de Mercado
    // Pago aunque payment_transfer_info tenga más filas activas (ej. Banco
    // Nación); el mail tiene que reflejar lo mismo que ve el cliente en
    // pantalla al elegir "transferencia".
    .eq("bank_name", "Mercado Pago")
    .order("position", { ascending: true });
  if (error) {
    console.error("Unable to load payment_transfer_info for confirmation email:", error.message);
  }
  return (data ?? []) as unknown as TransferAccountRow[];
}

export interface OrderConfirmationOrderRow {
  id: string;
  total_amount: number | string;
  subtotal_amount: number | string;
  shipping_amount: number | string;
  embalaje_amount: number | string | null;
  payment_commission_percentage: number | string | null;
  payment_commission_amount: number | string | null;
}

interface OrderConfirmationProductImageRow {
  image_url: string;
  position: number;
}

export interface OrderConfirmationProductRow {
  id: string;
  name: string;
  product_images: OrderConfirmationProductImageRow[] | null;
}

export interface OrderConfirmationVariantRow {
  sku: string;
  units_per_pack: number | null;
  products: OrderConfirmationProductRow | OrderConfirmationProductRow[] | null;
}

export interface OrderConfirmationItemRow {
  product_variant_id: string;
  quantity: number | string;
  unit_price: number | string;
  product_variants: OrderConfirmationVariantRow | OrderConfirmationVariantRow[] | null;
}

export interface OrderConfirmationCustomerRow {
  full_name: string;
  email: string;
  tax_id: string | null;
  phone_area_code: string | null;
  phone_number: string | null;
}

/** Fila de order_addresses usada para armar la sección "Envío" del mail de confirmación */
export interface OrderConfirmationAddressRow {
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

/** Supabase devuelve las relaciones como objeto o como lista de uno: se toma el primero. */
export const firstRow = <T>(value: T | T[] | null): T | null | undefined => (Array.isArray(value) ? value[0] : value);

export interface MercadoPagoOrderEmailData {
  order: OrderConfirmationOrderRow;
  items: OrderConfirmationItemRow[];
  customer: OrderConfirmationCustomerRow;
  address: OrderConfirmationAddressRow | null;
  taxes: TaxRule[];
  packagingBoxes: PackagingBox[];
}

/**
 * Datos de una orden pagada por Mercado Pago para su mail de confirmación. Tira si falta la
 * orden, los ítems o el cliente (sin eso no hay mail); la dirección y las cajas son opcionales.
 */
export async function loadMercadoPagoOrderEmailData(env: Env, orderId: string): Promise<MercadoPagoOrderEmailData> {
  const supabase = getSupabase(env);
  const [orderResult, itemsResult, customerResult, addressResult, taxes] = await Promise.all([
    supabase
      .from("orders")
      .select("id, total_amount, subtotal_amount, shipping_amount, embalaje_amount, payment_commission_percentage, payment_commission_amount")
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
            units_per_pack,
            products (
              id,
              name,
              product_images ( image_url, position )
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
      .maybeSingle(),
    getCachedTaxes(env)
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

  return { order, items, customer, address, taxes, packagingBoxes: await loadPackagingBoxes(env, order, items, address) };
}

/**
 * Embalaje: las cajas no se guardan en la orden, se reconstruyen a partir de order_items
 * (el importe ya está repartido dentro de order_items.unit_price, guardado en
 * orders.embalaje_amount solo para el registro). En órdenes viejas (antes del reparto por
 * caja) el embalaje iba dentro del precio de cada pack: ahí solo se muestran las cajas del
 * envío a domicilio, sin relación con lo cobrado. Si falla, el mail sale sin cajas.
 */
async function loadPackagingBoxes(
  env: Env,
  order: OrderConfirmationOrderRow,
  items: OrderConfirmationItemRow[],
  address: OrderConfirmationAddressRow | null
): Promise<PackagingBox[]> {
  const hasBoxEmbalaje = Number(order.embalaje_amount ?? 0) > 0;
  const productGroups = Array.from(items.reduce((acc, item) => {
    const variant = firstRow(item.product_variants);
    const product = firstRow(variant?.products ?? null);
    if (!product?.id) return acc;
    const unitsPerPack = Number(variant?.units_per_pack ?? 1);
    acc.set(product.id, (acc.get(product.id) ?? 0) + Number(item.quantity) * unitsPerPack);
    return acc;
  }, new Map<string, number>()), ([product_id, units]) => ({ product_id, units }));
  try {
    if (hasBoxEmbalaje) {
      return (await resolvePackagingPlan(env, productGroups)).boxes;
    }
    if (address?.shipping_method === "delivery" && address.postal_code) {
      const resolution = await resolveShippingRate(env, address.postal_code, productGroups, address.province);
      return resolution?.boxes ?? [];
    }
  } catch (error) {
    console.error("Unable to recompute packaging boxes for confirmation email:", error);
  }
  return [];
}
