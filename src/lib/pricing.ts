export const round = (val: number) => Math.round((val + Number.EPSILON) * 100) / 100;

export interface TaxRule {
  name: string;
  percentage: number;
  /** Si es true, el impuesto se suma al costo base antes de aplicar rentabilidad */
  is_computable: boolean;
  is_active: boolean;
}

/** Parámetros de entrada para el cálculo de precios V2 */
export interface PricingInput {
  cost_usd_master: number;
  cost_currency?: 'ARS' | 'USD';
  units_per_pack_master: number;
  presentation_quantity: number;
  exchange_rate: number;
  rentability_percentage: number;
  taxes?: TaxRule[];
  /** Embalaje sumado al precio. 0 por defecto: el embalaje se cobra por caja en la orden (ver embalajeBoxPriceArs). */
  embalaje_cost?: number;
  /** Costo de packaging diferenciado: se suma solo si la presentación lo lleva (default 0) */
  packaging_cost?: number;
  /** % que cobra el medio de pago (Mercado Pago). Todo el precio se divide por (1 − %) para que, con el
   *  descuento equivalente por transferencia, el vendedor cobre exactamente el precio sin recargo. */
  payment_gross_up_percentage?: number;
}

export interface PricingOutput {
  precio_unitario_neto: number;
  costo_presentacion: number;
  costo_total_operativo: number;
  precio_final_ars: number;
  precio_sin_impuestos_ars: number;
  detalles_tributos: {
    nombre: string;
    monto: number;
    es_computable: boolean;
  }[];
}

/** Factor por el que se multiplican precios y envío: 1 / (1 − % del medio de pago). Con 10% → 1,1111. */
export function paymentGrossUpFactor(paymentFeePercentage: number): number {
  if (!Number.isFinite(paymentFeePercentage) || paymentFeePercentage <= 0 || paymentFeePercentage >= 100) return 1;
  return 100 / (100 - paymentFeePercentage);
}

/**
 * Precio de lista de UNA caja de embalaje: costo fijo × (1 + margen), con el costo del medio de
 * pago incluido. Se cobra por caja del pedido (una o más cajas por modelo), no por pack.
 */
export function embalajeBoxPriceArs(
  embalajeCost: number,
  markupPercentage: number,
  paymentFeePercentage: number
): number {
  return Math.round(embalajeCost * (1 + markupPercentage / 100) * paymentGrossUpFactor(paymentFeePercentage));
}

/**
 * Parte del embalaje de un producto que le corresponde a una presentación (pack): el embalaje
 * del producto (sus propias cajas, nunca compartidas con otro producto) se reparte entre sus
 * unidades totales en el pedido, proporcional a las unidades de cada pack. Se usa tanto en el
 * backend (orden) como en el frontend (carrito, con el mismo cálculo) para que el precio de
 * cada línea coincida en los dos lados.
 */
export function embalajeShareForPack(
  productEmbalajeArs: number,
  productTotalUnits: number,
  presentationUnitsPerPack: number
): number {
  if (productTotalUnits <= 0) return 0;
  return Math.round((productEmbalajeArs / productTotalUnits) * presentationUnitsPerPack);
}

/**
 * Implementación definitiva del Motor de Precios V2.
 * Sigue el flujo: Costo Master -> Precio Unitario -> Costo Presentación -> Embalaje -> Rentabilidad.
 * @param input - Objeto de tipo PricingInput con los parámetros de cotización
 * @returns Objeto de tipo PricingOutput con el desglose de precios calculado
 */
export function calculatePriceV2(input: PricingInput): PricingOutput {
  // ─────────────────────────────────────────────────────────────
  // QUÉ HACE: Calcula el precio unitario, operativo y final aplicando impuestos, embalaje y rentabilidad.
  // POR QUÉ:  Permite inyectar dinámicamente el costo de embalaje desde la DB (Supabase) con fallback local.
  // CUIDADO:  El costo de embalaje influye directamente sobre el margen final de rentabilidad.
  // ─────────────────────────────────────────────────────────────
  const {
    cost_usd_master,
    units_per_pack_master,
    presentation_quantity,
    exchange_rate,
    rentability_percentage,
    taxes = [],
    embalaje_cost = 0,
    packaging_cost = 0,
    cost_currency = 'USD',
    payment_gross_up_percentage = 0
  } = input;
  const paymentGrossUp = paymentGrossUpFactor(payment_gross_up_percentage);

  // a & b. Precio bulto maestro en pesos
  const effectiveRate = cost_currency === 'ARS' ? 1 : exchange_rate;
  const precio_bulto_ars = cost_usd_master * effectiveRate;

  // c. Precio unitario base
  const precio_unitario_base = precio_bulto_ars / units_per_pack_master;
  // Precio final descontando solo los impuestos computables: incluye embalaje y packaging.
  const precio_sin_impuestos_ars = round((precio_unitario_base * presentation_quantity + embalaje_cost + packaging_cost) * (1 + rentability_percentage / 100) * paymentGrossUp);

  // d. Cálculo de tributos y costo unitario computable
  let costo_unitario_computable = precio_unitario_base;
  const detalles_tributos = [];

  for (const tax of taxes) {
    if (!tax.is_active) continue;
    
    const monto = precio_unitario_base * (tax.percentage / 100);
    detalles_tributos.push({
      nombre: tax.name,
      monto,
      es_computable: tax.is_computable
    });

    if (tax.is_computable) {
      costo_unitario_computable += monto;
    }
  }

  // e. Costo de la presentación (cantidad de unidades solicitadas)
  const costo_presentacion = costo_unitario_computable * presentation_quantity;

  // f. Costo total operativo (Presentación + Embalaje fijo + Packaging si aplica)
  const costo_total_operativo = costo_presentacion + embalaje_cost + packaging_cost;

  // g. Precio de venta final (Aplicando rentabilidad neta)
  const precio_final_ars = costo_total_operativo * (1 + rentability_percentage / 100) * paymentGrossUp;

  // Redondeo final a 2 decimales para precisión interna, 
  // la UI decidirá si redondea a entero.
  return {
    precio_unitario_neto: round(precio_unitario_base),
    costo_presentacion: round(costo_presentacion),
    costo_total_operativo: round(costo_total_operativo),
    precio_final_ars: round(precio_final_ars),
    precio_sin_impuestos_ars,
    detalles_tributos: detalles_tributos.map(t => ({ ...t, monto: round(t.monto) }))
  };
}

/** Resultado del medio de pago sobre el total de la orden. */
export interface OrderPaymentResult {
  /** % de descuento por pagar con transferencia (0 con otros medios). */
  paymentDiscountPercentage: number;
  paymentDiscountAmount: number;
  /** Total a cobrar: subtotal + envío − descuento. */
  total: number;
}

/**
 * Los precios de lista ya incluyen el costo del medio de pago (ver
 * `paymentGrossUpFactor`), así que Mercado Pago cobra el total de lista y la
 * transferencia recibe un descuento del `paymentFeePercentage` % sobre ese total.
 * Pesos enteros: lo que se ve es lo que se cobra.
 */
export function calculateOrderPayment(
  subtotalArs: number,
  shippingArs: number,
  paymentMethod: 'mercadopago' | 'transferencia',
  paymentFeePercentage: number
): OrderPaymentResult {
  const base = round(subtotalArs + shippingArs);
  if (paymentMethod !== 'transferencia' || paymentFeePercentage <= 0) {
    return { paymentDiscountPercentage: 0, paymentDiscountAmount: 0, total: base };
  }
  const paymentDiscountAmount = Math.round(base * (paymentFeePercentage / 100));
  return {
    paymentDiscountPercentage: paymentFeePercentage,
    paymentDiscountAmount,
    total: round(base - paymentDiscountAmount)
  };
}
