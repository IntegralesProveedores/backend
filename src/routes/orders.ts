import { getSupabase } from "../services/db";
import { getPricingConfig } from "../services/settings";
import { errorResponse, jsonResponse } from "../lib/response";
import { calculatePriceV2, TaxRule } from "../lib/pricing";
import { resolveVolumeDiscountFactor } from "../lib/products";

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

    const orderRef = crypto.randomUUID();

    return jsonResponse({
      items: validatedItems,
      total_ars: totalArs,
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
