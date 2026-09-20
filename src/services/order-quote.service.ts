import { getSupabase } from "./db";
import { getPricingConfig, getCachedTaxes, getCachedVolumeDiscounts } from "./settings";
import { calculatePriceV2, TaxRule, round as round2 } from "../lib/pricing";
import { resolveVolumeDiscountFactor } from "../lib/products";
import { ShippingInput } from "../lib/payment-input.validation";
import { ShippingBox, resolveShippingRate } from "./shipping.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Cotiza una orden (precio por ítem con descuento por volumen +
//           costo de envío) a partir de items + shipping. Único lugar
//           donde se calcula el precio de una orden.
// POR QUÉ:  El cálculo estaba duplicado entre routes/orders.ts (flujo
//           transferencia) y mercadopago-checkout.service.ts (flujo MP),
//           con el riesgo de que ambos precios diverjan con el tiempo.
// ─────────────────────────────────────────────────────────────

export class OrderQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrderQuoteError";
  }
}

export interface OrderQuoteItemInput {
  variant_id: string;
  quantity: number;
}

export interface OrderQuoteItem {
  // Campos de dominio, usados por el flujo de transferencia (respuesta al
  // cliente, persistencia de la orden y mail de confirmación).
  variant_id: string;
  product_id: string;
  sku: string;
  product_name: string;
  quantity: number;
  units_per_pack: number;
  units_per_pack_master: number;
  stock: number;
  cost_usd_master: number;
  /** cost_usd_master sin descuento por volumen aplicado (costo "de lista"). */
  cost_usd_master_original: number;
  cost_currency?: "ARS" | "USD";
  price_ars: number;
  price_usd: number;
  /** Precio sin descuento por volumen; solo se usa para el desglose
   *  "Subtotal / Descuento" del mail de confirmación de transferencia. */
  price_ars_no_discount: number;
  subtotal_ars: number;
  subtotal_usd: number;
  discount_factor: number;
  // Campos con forma de ítem de preferencia de Mercado Pago, usados por
  // mercadopago-checkout.service.ts al armar la preferencia de pago.
  id: string;
  title: string;
  description: string;
  currency_id: "ARS";
  unit_price: number;
}

export interface OrderQuote {
  items: OrderQuoteItem[];
  taxes: TaxRule[];
  /** Suma de subtotales de items, SIN envío. */
  subtotalArs: number;
  subtotalUsd: number;
  shippingArs: number;
  shippingBoxes: ShippingBox[];
  exchangeRate: number;
  paymentCommissionPercentage: number;
  /** Insumos para calcular el % de descuento por volumen ponderado que
   *  muestra el mail de confirmación de transferencia. */
  volumeDiscountWeightedSum: number;
  volumeDiscountTotalWeight: number;
}

export async function buildOrderQuote(
  env: Env,
  items: OrderQuoteItemInput[],
  shipping: ShippingInput
): Promise<OrderQuote> {
  const supabase = getSupabase(env);
  const [pricingConfig, taxes, volumeDiscounts] = await Promise.all([
    getPricingConfig(env),
    getCachedTaxes(env),
    getCachedVolumeDiscounts(env)
  ]);

  const quoteItems: OrderQuoteItem[] = [];
  let subtotalArs = 0;
  let subtotalUsd = 0;
  let volumeDiscountWeightedSum = 0;
  let volumeDiscountTotalWeight = 0;

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
        has_packaging,
        products (
          id,
          name,
          cost_usd,
          units_per_pack_master,
          cost_currency
        )
      `)
      .eq("id", item.variant_id)
      .single();

    if (error || !variant) {
      throw new OrderQuoteError(`Variant not found: ${item.variant_id}`);
    }
    if (!variant.is_active || variant.deleted_at !== null) {
      throw new OrderQuoteError(`Variant not available: ${variant.sku || item.variant_id}`);
    }

    const stockUnits = Number(variant.stock) || 0;
    if (stockUnits < item.quantity) {
      throw new OrderQuoteError(`Insufficient stock for variant: ${variant.sku || item.variant_id}`);
    }

    const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
    if (!product) {
      throw new OrderQuoteError(`Product not found for variant: ${variant.sku || item.variant_id}`);
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
      cost_currency: product.cost_currency,
      units_per_pack_master: unitsPerPackMaster,
      presentation_quantity: presentationQuantity,
      exchange_rate: pricingConfig.exchangeRate,
      rentability_percentage: pricingConfig.markups.minorista,
      taxes,
      embalaje_cost: pricingConfig.embalageCost,
      packaging_cost: variant.has_packaging ? (pricingConfig.packagingCost ?? 0) : 0
    });

    const priceArs = Math.round(pricing.precio_final_ars);
    const priceUsd = round2(priceArs / pricingConfig.exchangeRate);
    const itemSubtotalArs = priceArs * item.quantity;
    const itemSubtotalUsd = round2(priceUsd * item.quantity);

    subtotalArs += itemSubtotalArs;
    subtotalUsd += itemSubtotalUsd;

    // Precio sin descuento por volumen, usado únicamente para mostrar el
    // desglose "Subtotal / Descuento" en el mail de confirmación de
    // transferencia (ver sendTransferOrderConfirmationEmail).
    const pricingNoDiscount = calculatePriceV2({
      cost_usd_master: costUsdMaster,
      cost_currency: product.cost_currency,
      units_per_pack_master: unitsPerPackMaster,
      presentation_quantity: presentationQuantity,
      exchange_rate: pricingConfig.exchangeRate,
      rentability_percentage: pricingConfig.markups.minorista,
      taxes,
      embalaje_cost: pricingConfig.embalageCost,
      packaging_cost: variant.has_packaging ? (pricingConfig.packagingCost ?? 0) : 0
    });
    const priceArsNoDiscount = Math.round(pricingNoDiscount.precio_final_ars);
    if (discountFactor > 1) {
      volumeDiscountWeightedSum += (discountFactor - 1) * 100 * itemSubtotalArs;
      volumeDiscountTotalWeight += itemSubtotalArs;
    }

    quoteItems.push({
      variant_id: variant.id,
      product_id: String((product as { id: string }).id),
      sku: variant.sku,
      product_name: productName,
      quantity: item.quantity,
      units_per_pack: presentationQuantity,
      units_per_pack_master: unitsPerPackMaster,
      stock: stockUnits,
      cost_usd_master: costUsdMasterWithDiscount,
      cost_usd_master_original: costUsdMaster,
      cost_currency: product.cost_currency,
      price_ars: priceArs,
      price_usd: priceUsd,
      price_ars_no_discount: priceArsNoDiscount,
      subtotal_ars: itemSubtotalArs,
      subtotal_usd: itemSubtotalUsd,
      discount_factor: discountFactor,
      id: variant.id,
      title: productName,
      description: `SKU ${variant.sku}`,
      currency_id: "ARS",
      unit_price: priceArs
    });
  }

  const productGroups = Array.from(quoteItems.reduce((groups, item) => {
    groups.set(item.product_id, (groups.get(item.product_id) ?? 0) + item.quantity * item.units_per_pack);
    return groups;
  }, new Map<string, number>()), ([product_id, units]) => ({ product_id, units }));

  let shippingArs = 0;
  let shippingBoxes: ShippingBox[] = [];
  if (shipping.method === "delivery" && shipping.address?.postal_code) {
    const shippingResolution = await resolveShippingRate(env, shipping.address.postal_code, productGroups);
    shippingArs = shippingResolution?.priceArs ?? 0;
    shippingBoxes = shippingResolution?.boxes ?? [];
  }

  return {
    items: quoteItems,
    taxes,
    subtotalArs,
    subtotalUsd: round2(subtotalUsd),
    shippingArs,
    shippingBoxes,
    exchangeRate: pricingConfig.exchangeRate,
    paymentCommissionPercentage: pricingConfig.paymentCommissionPercentage,
    volumeDiscountWeightedSum,
    volumeDiscountTotalWeight
  };
}
