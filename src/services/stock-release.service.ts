import { getSupabase } from "./db";
import { MercadoPagoService } from "./mercadopago.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Cancela las órdenes pendientes que quedaron abandonadas y
//           devuelve su stock (RPC restore_order_stock).
// POR QUÉ:  El stock se descuenta al confirmar la orden (transferencia y
//           Mercado Pago). Si el cliente no paga, ese stock quedaba reservado
//           para siempre.
// CUIDADO:  Nunca cancela una orden que Mercado Pago tenga aprobada (el
//           webhook pudo perderse). Las transferencias solo vencen si existe
//           la fila `transfer_hold_hours` en pricing_settings: es una decisión
//           de negocio y sin esa fila no se libera ninguna.
// ─────────────────────────────────────────────────────────────

/** La preferencia de MP vence a las 24 h (buildPreference); se deja 1 h de margen. */
const MERCADOPAGO_HOLD_HOURS = 25;
const MAX_ORDERS_PER_RUN = 50;

interface PendingOrderRow {
  id: string;
  external_reference: string | null;
  payment_method: "mercadopago" | "transferencia";
}

export interface StockReleaseResult {
  released: string[];
  skipped: string[];
}

async function getTransferHoldHours(env: Env): Promise<number | null> {
  const { data, error } = await getSupabase(env)
    .from("pricing_settings")
    .select("value")
    .eq("key", "transfer_hold_hours")
    .eq("is_active", true)
    .maybeSingle();
  if (error) throw new Error(`Unable to load transfer_hold_hours: ${error.message}`);
  const hours = Number(data?.value);
  return Number.isFinite(hours) && hours > 0 ? hours : null;
}

async function findExpiredOrders(
  env: Env,
  method: PendingOrderRow["payment_method"],
  hours: number
): Promise<PendingOrderRow[]> {
  const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const { data, error } = await getSupabase(env)
    .from("orders")
    .select("id, external_reference, payment_method")
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .eq("payment_method", method)
    .not("stock_decremented_at", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(MAX_ORDERS_PER_RUN);
  if (error) throw new Error(`Unable to load expired ${method} orders: ${error.message}`);
  return (data ?? []) as unknown as PendingOrderRow[];
}

/** Devuelve el stock de una orden (idempotente: solo actúa si estaba descontado). */
export async function restoreOrderStock(env: Env, orderId: string): Promise<boolean> {
  const { data, error } = await getSupabase(env).rpc("restore_order_stock", { p_order_id: orderId });
  if (error) throw new Error(`Unable to restore stock for order ${orderId}: ${error.message}`);
  return data === true;
}

async function cancelAndRestore(env: Env, orderId: string): Promise<boolean> {
  // La condición status='pending' evita pisar una orden que se pagó entre la lectura y este update.
  const { data, error } = await getSupabase(env)
    .from("orders")
    .update({
      status: "cancelled",
      payment_status: "cancelled",
      cancelled_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .eq("id", orderId)
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .select("id");
  if (error) throw new Error(`Unable to cancel order ${orderId}: ${error.message}`);
  if (!data?.length) return false;
  await restoreOrderStock(env, orderId);
  return true;
}

/**
 * El cliente volvió de Mercado Pago sin pagar (pantalla de error): cancela esa orden
 * y devuelve el stock, en vez de esperar las 25 h del cron. Devuelve false si no había
 * nada que cancelar o si Mercado Pago ya tiene un pago aprobado (el webhook puede demorar).
 */
export async function abandonMercadoPagoOrder(env: Env, externalReference: string): Promise<boolean> {
  const { data, error } = await getSupabase(env)
    .from("orders")
    .select("id")
    .eq("external_reference", externalReference)
    .eq("payment_method", "mercadopago")
    .eq("status", "pending")
    .eq("payment_status", "pending")
    .not("stock_decremented_at", "is", null)
    .maybeSingle();
  if (error) throw new Error(`Unable to load order for abandon: ${error.message}`);
  if (!data) return false;

  if (await new MercadoPagoService(env.MP_ACCESS_TOKEN).hasApprovedPayment(externalReference)) return false;
  return cancelAndRestore(env, String((data as { id: string }).id));
}

export async function releaseAbandonedOrders(env: Env): Promise<StockReleaseResult> {
  const result: StockReleaseResult = { released: [], skipped: [] };

  const mercadoPagoOrders = await findExpiredOrders(env, "mercadopago", MERCADOPAGO_HOLD_HOURS);
  const mercadoPago = mercadoPagoOrders.length ? new MercadoPagoService(env.MP_ACCESS_TOKEN) : null;
  for (const order of mercadoPagoOrders) {
    try {
      if (!order.external_reference || !mercadoPago) {
        result.skipped.push(order.id);
        continue;
      }
      // Si MP tiene un pago aprobado, el webhook se perdió: no se cancela (revisar a mano).
      if (await mercadoPago.hasApprovedPayment(order.external_reference)) {
        console.error(JSON.stringify({ event: "stock_release_skipped_paid_order", order_id: order.id }));
        result.skipped.push(order.id);
        continue;
      }
      if (await cancelAndRestore(env, order.id)) result.released.push(order.id);
    } catch (error) {
      console.error(JSON.stringify({ event: "stock_release_failed", order_id: order.id, message: String(error) }));
      result.skipped.push(order.id);
    }
  }

  const transferHours = await getTransferHoldHours(env);
  if (transferHours !== null) {
    for (const order of await findExpiredOrders(env, "transferencia", transferHours)) {
      try {
        if (await cancelAndRestore(env, order.id)) result.released.push(order.id);
      } catch (error) {
        console.error(JSON.stringify({ event: "stock_release_failed", order_id: order.id, message: String(error) }));
        result.skipped.push(order.id);
      }
    }
  }

  console.log(JSON.stringify({ event: "stock_release_run", released: result.released.length, skipped: result.skipped.length }));
  return result;
}
