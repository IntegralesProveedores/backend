import { getSupabase } from "../services/db";
import { getPricingConfig } from "../services/settings";
import { errorResponse, jsonResponse } from "../lib/response";
import { calculatePriceV2, TaxRule } from "../lib/pricing";
import { resolveVolumeDiscountFactor } from "../lib/products";
import { createOrderRecord, getShippingPriceArs, parseShippingInput, PaymentInputError, validateShippingInput, ShippingInput } from "../services/payment.service";

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
};

const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;

const isValidEmail = (value: unknown): value is string => {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

export async function handleCreateOrder({ request, env }: { request: Request; env: any }) {
  try {
    const body = await request.json() as OrderBody;
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

    if (!Array.isArray(items) || items.length === 0) {
      return errorResponse("items must be a non-empty array", 400);
    }

    if (!customer || !isValidEmail(customer.email)) {
      return errorResponse("customer.email is invalid", 400);
    }

    for (const [index, item] of items.entries()) {
      if (!item || typeof item.variant_id !== "string" || !Number.isInteger(item.quantity) || item.quantity <= 0) {
        return errorResponse(`Invalid item at index ${index}`, 400);
      }
    }

    const supabase = getSupabase(env);
    const pricingConfig = await getPricingConfig(env);

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

    const taxes = (taxesResult.data ?? []).map((t: any): TaxRule => ({
      name: t.name,
      percentage: Number(t.percentage),
      is_computable: t.is_computable,
      is_active: t.is_active
    }));

    const volumeDiscounts = (discountsResult.data ?? []).map((d: any) => ({
      min: Number(d.min_quantity),
      factor: Number(d.factor)
    }));

    const validatedItems = [];
    let totalArs = 0;
    let totalUsd = 0;
    let totalEquivalentPacks = 0;

    for (const item of items) {
      const { data: variant, error } = await supabase
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
        .eq("id", item.variant_id)
        .single();

      if (error || !variant) {
        return errorResponse(`Variant not found: ${item.variant_id}`, 400);
      }

      if (!variant.is_active || variant.deleted_at !== null) {
        return errorResponse(`Variant not available: ${variant.sku || item.variant_id}`, 400);
      }

      const stockUnits = Number(variant.stock) || 0;
      if (stockUnits < item.quantity) {
        return errorResponse(`Insufficient stock for variant: ${variant.sku || item.variant_id}`, 400);
      }

      const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
      if (!product) {
        return errorResponse(`Product not found for variant: ${variant.sku || item.variant_id}`, 400);
      }

      const productName = product.name || variant.sku;
      const costUsdMaster = Number(product.cost_usd) || 0;
      const unitsPerPackMaster = Number(product.units_per_pack_master) || 1;
      const presentationQuantity = Number(variant.units_per_pack) || 1;
      totalEquivalentPacks += (presentationQuantity * item.quantity) / unitsPerPackMaster;
      const equivalentPacks = (presentationQuantity * item.quantity) / unitsPerPackMaster;
      const discountFactor = resolveVolumeDiscountFactor(equivalentPacks, volumeDiscounts);
      const costUsdMasterWithDiscount = round2(costUsdMaster / discountFactor);

      const pricing = calculatePriceV2({
        cost_usd_master: costUsdMasterWithDiscount,
        units_per_pack_master: unitsPerPackMaster,
        presentation_quantity: presentationQuantity,
        exchange_rate: pricingConfig.exchangeRate,
        rentability_percentage: pricingConfig.markups.minorista,
        taxes,
        embalaje_cost: pricingConfig.embalageCost
      });

      const priceArs = Math.round(pricing.precio_final_ars);
      const priceUsd = round2(priceArs / pricingConfig.exchangeRate);
      const subtotalArs = priceArs * item.quantity;
      const subtotalUsd = round2(priceUsd * item.quantity);

      totalArs += subtotalArs;
      totalUsd += subtotalUsd;

      validatedItems.push({
        variant_id: variant.id,
        sku: variant.sku,
        product_name: productName,
        quantity: item.quantity,
        units_per_pack: presentationQuantity,
        stock: stockUnits,
        cost_usd_master: costUsdMasterWithDiscount,
        price_ars: priceArs,
        price_usd: priceUsd,
        subtotal_ars: subtotalArs,
        subtotal_usd: subtotalUsd,
        product: {
          name: productName,
          cost_usd: costUsdMaster,
          units_per_pack_master: unitsPerPackMaster
        }
      });
    }

    const totalUnits = Math.round(1000 * totalEquivalentPacks);
    const shippingArs = await getShippingPriceArs(env, shipping, totalUnits);
    totalArs += shippingArs;

    const orderRef = crypto.randomUUID();

    await createOrderRecord(
      env,
      customer,
      validatedItems.map(item => ({
        variant_id: item.variant_id,
        sku: item.sku,
        product_name: item.product_name,
         quantity: item.quantity,
         units_per_pack: item.units_per_pack,
         units_per_pack_master: item.product.units_per_pack_master,
         unit_price: item.price_ars
      })),
      totalArs - shippingArs,
      pricingConfig.exchangeRate,
      orderRef,
      "manual",
      shipping
    );

    return jsonResponse({
      items: validatedItems,
      total_ars: totalArs,
      shipping_ars: shippingArs,
      total_usd: round2(totalUsd),
      exchange_rate: pricingConfig.exchangeRate,
      order_ref: orderRef,
      customer: {
        nombre: customer.nombre,
        email: customer.email,
        cuit: customer.cuit,
        codigoArea: customer.codigoArea,
        celular: customer.celular
      }
    });
  } catch (e: any) {
    return errorResponse(`handleCreateOrder Error: ${e.message}`, 500, { stack: e.stack });
  }
}

/** Devuelve la orden agregada para el futuro detalle de /orden/:id. */
export async function handleGetOrder({ env, params }: { env: any; params: Record<string, string> }) {
  const orderId = params.id;
  const supabase = getSupabase(env);
  const [orderResult, itemsResult, customerResult, addressResult] = await Promise.all([
    supabase.from("orders").select("*").eq("id", orderId).single(),
    supabase.from("order_items").select("*").eq("order_id", orderId),
    supabase.from("order_customers").select("*").eq("order_id", orderId).maybeSingle(),
    supabase.from("order_addresses").select("*").eq("order_id", orderId).maybeSingle()
  ]);

  if (orderResult.error || !orderResult.data) {
    return errorResponse("Order not found", 404);
  }
  if (itemsResult.error || customerResult.error || addressResult.error) {
    return errorResponse("Unable to load order details", 500);
  }

  return jsonResponse({
    order: orderResult.data,
    items: (itemsResult.data ?? []).map((item: any) => ({
      id: item.id,
      variant_id: item.product_variant_id,
      quantity: item.quantity,
      unit_price: item.unit_price,
      subtotal: Number(item.unit_price) * Number(item.quantity)
    })),
    customer: customerResult.data ? {
      nombre: customerResult.data.full_name,
      email: customerResult.data.email,
      cuit: customerResult.data.tax_id,
      codigoArea: customerResult.data.phone_area_code,
      celular: customerResult.data.phone_number
    } : null,
    shipping: {
      method: addressResult.data?.shipping_method ?? "pickup",
      address: addressResult.data ? {
        recipient_name: addressResult.data.recipient_name,
        postal_code: addressResult.data.postal_code,
        province: addressResult.data.province,
        locality: addressResult.data.locality,
        county: addressResult.data.county,
        street: addressResult.data.street,
        street_number: addressResult.data.street_number,
        floor: addressResult.data.floor,
        apartment: addressResult.data.apartment,
        country: addressResult.data.country
      } : null
    }
  });
}
