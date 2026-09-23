import { getSupabase } from "./db";
import { getPricingConfig, getCachedTaxes, getCachedVolumeDiscounts } from "./settings";
import { calculatePriceV2, TaxRule, round as round2, embalajeBoxPriceArs, embalajeShareForPack } from "../lib/pricing";
import { resolveVolumeDiscountPercentage } from "../lib/products";
import { ShippingInput } from "../lib/payment-input.validation";
import { PackagingBox, ProductGroup, resolvePackagingPlan, resolveShippingRate } from "./shipping.service";

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

/** El total calculado ahora no coincide con el que vio el cliente (cambió el dólar, un precio o el envío). */
export class PriceChangedError extends Error {
  constructor(readonly currentTotalArs: number, readonly expectedTotalArs: number) {
    super("Prices changed since the total was shown");
    this.name = "PriceChangedError";
  }
}

/** Diferencia máxima aceptada (en pesos) entre el total mostrado y el calculado. */
const EXPECTED_TOTAL_TOLERANCE_ARS = 1;

/**
 * Rechaza la orden si el total que vio el cliente difiere del calculado. Sin
 * expected_total_ars (frontend viejo) no se valida.
 */
export function assertExpectedTotal(expectedTotalArs: number | undefined, currentTotalArs: number): void {
  if (expectedTotalArs === undefined) return;
  if (Math.abs(expectedTotalArs - currentTotalArs) > EXPECTED_TOTAL_TOLERANCE_ARS) {
    throw new PriceChangedError(currentTotalArs, expectedTotalArs);
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
  /** Precio unitario sin impuestos ("Sin impuestos Nacionales" del resumen y del mail). */
  price_ars_no_tax: number;
  /** Primera imagen del producto (ruta relativa o URL), para la miniatura del mail. */
  image_url: string | null;
  subtotal_ars: number;
  subtotal_usd: number;
  discount_percentage: number;
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
  /** Cajas del pedido (una o más por modelo de maceta), con o sin envío. */
  packagingBoxes: PackagingBox[];
  /** Embalaje total, ya repartido dentro del precio de cada producto (`items[].price_ars`).
   *  Informativo: no se suma aparte al total, ver `payment.ts` / `orders.repository.ts`. */
  embalajeArs: number;
  exchangeRate: number;
  paymentCommissionPercentage: number;
  /** Subtotal a precios de lista (sin descuento por volumen). Con `subtotalArs` da el
   *  % de descuento real que muestra el mail de confirmación. */
  subtotalNoDiscountArs: number;
}

function pickFirstImageUrl(images?: Array<{ image_url: string; position: number }> | null): string | null {
  if (!images?.length) return null;
  return [...images].sort((a, b) => a.position - b.position)[0]?.image_url ?? null;
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
  let subtotalNoDiscountArs = 0;
  const requestedUnitsByProduct = new Map<string, number>();
  // Primera pasada: se resuelve y valida cada ítem. El descuento por volumen se define
  // recién después, mirando el carrito entero.
  const resolvedItems: Array<{
    item: OrderQuoteItemInput;
    variant: any;
    product: any;
    productName: string;
    costUsdMaster: number;
    unitsPerPackMaster: number;
    presentationQuantity: number;
    stockUnits: number;
  }> = [];

  // Una sola consulta para todas las variantes del carrito (antes era 1 consulta secuencial
  // por ítem: con MAX_ORDER_ITEMS=50 podían ser hasta 50 idas y vueltas a la base en el
  // momento de pagar, arriesgando el límite de subsolicitudes de una invocación del Worker).
  const variantIds = [...new Set(items.map(item => item.variant_id))];
  const { data: variantRows, error: variantsError } = await supabase
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
        cost_currency,
        stock_units,
        product_images ( image_url, position )
      )
    `)
    .in("id", variantIds);
  if (variantsError) throw new OrderQuoteError(`Unable to load variants: ${variantsError.message}`);
  const variantsById = new Map((variantRows ?? []).map((v: any) => [v.id, v]));

  for (const item of items) {
    const variant = variantsById.get(item.variant_id);

    if (!variant) {
      throw new OrderQuoteError(`Variant not found: ${item.variant_id}`);
    }
    if (!variant.is_active || variant.deleted_at !== null) {
      throw new OrderQuoteError(`Variant not available: ${variant.sku || item.variant_id}`);
    }

    const product = Array.isArray(variant.products) ? variant.products[0] : variant.products;
    if (!product) {
      throw new OrderQuoteError(`Product not found for variant: ${variant.sku || item.variant_id}`);
    }

    const productName = product.name || variant.sku;
    const costUsdMaster = Number(product.cost_usd) || 0;
    const unitsPerPackMaster = Number(product.units_per_pack_master) || 1;
    const presentationQuantity = Number(variant.units_per_pack) || 1;

    // El stock vive en products.stock_units (unidades sueltas). Se valida
    // contra el total pedido del producto, sumando todas sus presentaciones.
    const productStockUnits = Number(product.stock_units) || 0;
    const requestedUnits = (requestedUnitsByProduct.get(product.id) ?? 0) + presentationQuantity * item.quantity;
    if (requestedUnits > productStockUnits) {
      throw new OrderQuoteError(`Insufficient stock for variant: ${variant.sku || item.variant_id}`);
    }
    requestedUnitsByProduct.set(product.id, requestedUnits);
    const stockUnits = Math.floor(productStockUnits / presentationQuantity);
    resolvedItems.push({ item, variant, product, productName, costUsdMaster, unitsPerPackMaster, presentationQuantity, stockUnits });
  }

  // Si algún producto alcanza un tramo de descuento, ese descuento se aplica a TODOS los
  // productos del carrito (así agregar otros productos nunca lo reduce).
  const discountPercentage = Math.max(0, ...resolvedItems.map(r =>
    resolveVolumeDiscountPercentage((r.presentationQuantity * r.item.quantity) / r.unitsPerPackMaster, volumeDiscounts)
  ));

  // Unidades totales por producto (todas sus presentaciones juntas), para el plan de cajas y
  // para repartir el embalaje de cada producto entre sus líneas (ver embalajeShareForPack).
  const productUnitsMap = new Map<string, number>();
  for (const r of resolvedItems) {
    const productId = String(r.product.id);
    productUnitsMap.set(productId, (productUnitsMap.get(productId) ?? 0) + r.presentationQuantity * r.item.quantity);
  }
  const productGroups: ProductGroup[] = Array.from(productUnitsMap, ([product_id, units]) => ({ product_id, units }));

  // Embalaje: se cobra por caja (una o más por modelo de maceta), no por pack, y se reparte
  // dentro del precio de cada producto (nunca se comparte entre productos distintos). Aplica
  // con cualquier método de entrega.
  const packagingPlan = await resolvePackagingPlan(env, productGroups);
  const boxPriceArs = embalajeBoxPriceArs(
    pricingConfig.embalageCost,
    pricingConfig.markups.embalaje,
    pricingConfig.paymentCommissionPercentage
  );
  const productEmbalajeArsMap = new Map(
    Array.from(packagingPlan.perProductBoxCount, ([productId, count]) => [productId, count * boxPriceArs])
  );
  let embalajeArsCharged = 0;

  for (const { item, variant, product, productName, costUsdMaster, unitsPerPackMaster, presentationQuantity, stockUnits } of resolvedItems) {
    const costUsdMasterWithDiscount = round2(costUsdMaster * (1 - discountPercentage / 100));
    const productId = String(product.id);
    const embalajePerPack = embalajeShareForPack(
      productEmbalajeArsMap.get(productId) ?? 0,
      productUnitsMap.get(productId) ?? 0,
      presentationQuantity
    );

    const pricing = calculatePriceV2({
      cost_usd_master: costUsdMasterWithDiscount,
      cost_currency: product.cost_currency,
      units_per_pack_master: unitsPerPackMaster,
      presentation_quantity: presentationQuantity,
      exchange_rate: pricingConfig.exchangeRate,
      rentability_percentage: pricingConfig.markups.minorista,
      taxes,
      packaging_cost: variant.has_packaging ? (pricingConfig.packagingCost ?? 0) : 0,
      payment_gross_up_percentage: pricingConfig.paymentCommissionPercentage
    });

    // El embalaje no lleva IVA ni descuento por volumen: se suma tal cual al precio ya calculado.
    const priceArs = Math.round(pricing.precio_final_ars) + embalajePerPack;
    const priceUsd = round2(priceArs / pricingConfig.exchangeRate);
    const itemSubtotalArs = priceArs * item.quantity;
    const itemSubtotalUsd = round2(priceUsd * item.quantity);

    subtotalArs += itemSubtotalArs;
    subtotalUsd += itemSubtotalUsd;
    embalajeArsCharged += embalajePerPack * item.quantity;

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
      packaging_cost: variant.has_packaging ? (pricingConfig.packagingCost ?? 0) : 0,
      payment_gross_up_percentage: pricingConfig.paymentCommissionPercentage
    });
    // Mismo embalaje sin importar el descuento (el embalaje no se descuenta por volumen).
    const priceArsNoDiscount = Math.round(pricingNoDiscount.precio_final_ars) + embalajePerPack;
    subtotalNoDiscountArs += priceArsNoDiscount * item.quantity;

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
      // El embalaje no lleva IVA, así que suma completo también acá (igual que en price_ars).
      price_ars_no_tax: Math.round(pricing.precio_sin_impuestos_ars) + embalajePerPack,
      image_url: pickFirstImageUrl((product as { product_images?: Array<{ image_url: string; position: number }> }).product_images),
      subtotal_ars: itemSubtotalArs,
      subtotal_usd: itemSubtotalUsd,
      discount_percentage: discountPercentage,
      id: variant.id,
      title: productName,
      description: `SKU ${variant.sku}`,
      currency_id: "ARS",
      unit_price: priceArs
    });
  }

  let shippingArs = 0;
  if (shipping.method === "delivery" && shipping.address?.postal_code) {
    const shippingResolution = await resolveShippingRate(env, shipping.address.postal_code, productGroups, shipping.address.province);
    // Sin zona no hay tarifa: antes esto se cobraba como envío gratis ($0).
    if (!shippingResolution) {
      throw new OrderQuoteError("Shipping is not available for the postal code provided");
    }
    shippingArs = shippingResolution.priceArs;
  }

  return {
    items: quoteItems,
    taxes,
    subtotalArs,
    subtotalUsd: round2(subtotalUsd),
    shippingArs,
    packagingBoxes: packagingPlan.boxes,
    embalajeArs: embalajeArsCharged,
    exchangeRate: pricingConfig.exchangeRate,
    paymentCommissionPercentage: pricingConfig.paymentCommissionPercentage,
    subtotalNoDiscountArs
  };
}
