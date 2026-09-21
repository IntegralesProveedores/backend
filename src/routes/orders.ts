import { getSupabase } from "../services/db";
import { errorResponse, jsonResponse, priceChangedResponse } from "../lib/response";
import { calculateOrderCommission } from "../lib/pricing";
import { createOrderRecord } from "../services/orders.repository";
import {
  parseShippingInput,
  PaymentInputError,
  validateShippingInput,
  validateCustomerInput,
  ShippingInput,
  MAX_ORDER_ITEMS,
  isValidEmail,
  parseExpectedTotal
} from "../lib/payment-input.validation";
import { assertExpectedTotal, buildOrderQuote, OrderQuoteError, PriceChangedError } from "../services/order-quote.service";
import { sendTransferOrderConfirmationEmail } from "../services/email/order-confirmation-templates";
import { enforceRateLimit } from "../lib/rate-limit";
import { verifyTurnstile } from "../lib/turnstile";
import { readJsonBody } from "../lib/request";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderItemInput = {
  variant_id: string;
  quantity: number;
};

type OrderCustomerInput = {
  nombre: string;
  email: string;
  cuit: string;
  codigoArea: string;
  celular: string;
};

type OrderBody = {
  items?: OrderItemInput[];
  customer?: OrderCustomerInput;
  shipping?: unknown;
  payment_method?: string;
  turnstile_token?: string;
  expected_total_ars?: unknown;
};

export async function handleCreateOrder({ request, env }: { request: Request; env: any }) {
  const limited = await enforceRateLimit(env, request, "orders");
  if (limited) return limited;

  try {
    const body = await readJsonBody(request) as OrderBody | null;
    if (!body || typeof body !== "object") return errorResponse("Invalid JSON body", 400);

    // Este endpoint es solo para transferencia. Mercado Pago pasa por
    // /payments/create; aceptarlo acá dejaba órdenes "pending" sin pago ni stock.
    if (body.payment_method !== "transferencia") {
      return errorResponse("payment_method must be 'transferencia'; use /payments/create for Mercado Pago", 400);
    }

    const captchaFailure = await verifyTurnstile(env, request, body?.turnstile_token);
    if (captchaFailure) return captchaFailure;

    const items = body?.items;
    const customer = body?.customer;
    let shipping: ShippingInput;

    try {
      shipping = parseShippingInput(body?.shipping);
      validateShippingInput(shipping);
    } catch (error) {
      if (error instanceof PaymentInputError) return errorResponse(error.message, 400);
      throw error;
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > MAX_ORDER_ITEMS) {
      return errorResponse(`items must contain between 1 and ${MAX_ORDER_ITEMS} entries`, 400);
    }

    if (!customer || !isValidEmail(customer.email)) {
      return errorResponse("customer.email is invalid", 400);
    }
    try {
      validateCustomerInput(customer);
    } catch (error) {
      if (error instanceof PaymentInputError) return errorResponse(error.message, 400);
      throw error;
    }

    for (const [index, item] of items.entries()) {
      if (!item || typeof item.variant_id !== "string" || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        return errorResponse(`Invalid item at index ${index}`, 400);
      }
    }

    let quote;
    try {
      quote = await buildOrderQuote(env, items, shipping);
    } catch (error) {
      if (error instanceof OrderQuoteError) return errorResponse(error.message, 400);
      throw error;
    }

    const paymentMethod = body.payment_method;
    const commission = calculateOrderCommission(quote.subtotalArs, quote.shippingArs, paymentMethod, quote.paymentCommissionPercentage);

    try {
      assertExpectedTotal(parseExpectedTotal(body.expected_total_ars), commission.totalConComision);
    } catch (error) {
      if (error instanceof PriceChangedError) return priceChangedResponse(error.currentTotalArs, error.expectedTotalArs);
      if (error instanceof PaymentInputError) return errorResponse(error.message, 400);
      throw error;
    }

    const orderRef = crypto.randomUUID();

    const order = await createOrderRecord(
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
      paymentMethod,
      commission.paymentCommissionPercentage,
      commission.paymentCommissionAmount
    );

    if (paymentMethod === "transferencia") {
      // El stock se descuenta al confirmar el pedido (no al acreditarse la
      // transferencia). decrement_order_stock es atómica e idempotente
      // (orders.stock_decremented_at); si no alcanza el stock, se revierte
      // la orden y no se manda el mail.
      const supabase = getSupabase(env);
      const { error: stockError } = await supabase.rpc("decrement_order_stock", { p_order_id: order.id });
      if (stockError) {
        await supabase.from("orders").delete().eq("id", order.id);
        return errorResponse("Insufficient stock to complete the order", 409, { supabase_error: stockError.message });
      }

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
        shippingBoxes: quote.shippingBoxes,
        totalArs: commission.totalConComision,
        volumeDiscountPercentage,
        vatLabel,
        // El resumen del checkout muestra el % de comisión de MP que se ahorra
        // pagando por transferencia; la comisión efectiva de esta orden es 0.
        transferSavingsPercentage: quote.paymentCommissionPercentage
      });
    }

    return jsonResponse({
      items: quote.items.map(item => ({
        variant_id: item.variant_id,
        sku: item.sku,
        product_name: item.product_name,
        quantity: item.quantity,
        units_per_pack: item.units_per_pack,
        stock: item.stock,
        cost_usd_master: item.cost_usd_master,
        price_ars: item.price_ars,
        price_usd: item.price_usd,
        subtotal_ars: item.subtotal_ars,
        subtotal_usd: item.subtotal_usd,
        price_ars_no_discount: item.price_ars_no_discount,
        product: {
          id: item.product_id,
          name: item.product_name,
          cost_usd: item.cost_usd_master_original,
          units_per_pack_master: item.units_per_pack_master
        }
      })),
      total_ars: commission.totalConComision,
      shipping_ars: quote.shippingArs,
      // Total real (productos + envío + comisión) en USD; antes era solo el subtotal de productos.
      total_usd: Math.round((commission.totalConComision / quote.exchangeRate + Number.EPSILON) * 100) / 100,
      exchange_rate: quote.exchangeRate,
      order_ref: orderRef,
      payment_method: paymentMethod,
      payment_commission_percentage: commission.paymentCommissionPercentage,
      payment_commission_amount: commission.paymentCommissionAmount,
      customer: {
        nombre: customer.nombre,
        email: customer.email,
        cuit: customer.cuit,
        codigoArea: customer.codigoArea,
        celular: customer.celular
      }
    });
  } catch (e: any) {
    return errorResponse("Unable to create order", 500, { original_message: e.message, stack: e.stack });
  }
}

/**
 * Devuelve el estado agregado de una orden para el futuro detalle de
 * /orden/:id. Este endpoint no exige autenticación (se accede solo con el
 * UUID de la orden), así que la respuesta se limita deliberadamente a
 * datos no sensibles: no incluye nombre, CUIT, teléfono ni dirección del
 * cliente. Ese detalle completo debe consultarse desde un canal
 * autenticado si se necesita en el futuro.
 */
export async function handleGetOrder({ env, params, request }: { env: any; params: Record<string, string>; request: Request }) {
  const limited = await enforceRateLimit(env, request, "orders/get");
  if (limited) return limited;

  const orderId = params.id;
  if (!UUID_REGEX.test(orderId)) return errorResponse("Invalid order id", 400);
  const supabase = getSupabase(env);
  const [orderResult, itemsResult] = await Promise.all([
    supabase
      .from("orders")
      .select("status, payment_status, shipping_status, subtotal_amount, shipping_amount, total_amount, payment_commission_percentage, payment_commission_amount, external_reference, created_at")
      .eq("id", orderId)
      .single(),
    supabase.from("order_items").select("*").eq("order_id", orderId)
  ]);

  if (orderResult.error || !orderResult.data) {
    return errorResponse("Order not found", 404);
  }
  if (itemsResult.error) {
    return errorResponse("Unable to load order details", 500);
  }

  const order = orderResult.data as any;

  return jsonResponse({
    order_ref: order.external_reference,
    status: order.status,
    payment_status: order.payment_status,
    shipping_status: order.shipping_status,
    created_at: order.created_at,
    items: (itemsResult.data ?? []).map((item: any) => ({
      id: item.id,
      variant_id: item.product_variant_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: Number(item.unit_price) * Number(item.quantity)
    })),
    totals: {
      subtotal_ars: order.subtotal_amount,
      shipping_ars: order.shipping_amount,
      total_ars: order.total_amount,
      payment_commission_percentage: order.payment_commission_percentage,
      payment_commission_amount: order.payment_commission_amount
    }
  });
}
