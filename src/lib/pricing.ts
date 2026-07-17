export const EMBALAJE_COST = 745.56;

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
  units_per_pack_master: number;
  presentation_quantity: number;
  exchange_rate: number;
  rentability_percentage: number;
  taxes?: TaxRule[];
  /** Costo fijo de embalaje a aplicar (opcional, fallback a EMBALAJE_COST) */
  embalaje_cost?: number;
}

export interface PricingOutput {
  precio_unitario_neto: number;
  costo_presentacion: number;
  costo_total_operativo: number;
  precio_final_ars: number;
  detalles_tributos: {
    nombre: string;
    monto: number;
    es_computable: boolean;
  }[];
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
    embalaje_cost = EMBALAJE_COST
  } = input;

  // a & b. Precio bulto maestro en pesos
  const precio_bulto_ars = cost_usd_master * exchange_rate;

  // c. Precio unitario base
  const precio_unitario_base = precio_bulto_ars / units_per_pack_master;

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

  // f. Costo total operativo (Presentación + Embalaje fijo)
  const costo_total_operativo = costo_presentacion + embalaje_cost;

  // g. Precio de venta final (Aplicando rentabilidad neta)
  const precio_final_ars = costo_total_operativo * (1 + rentability_percentage / 100);

  // Redondeo final a 2 decimales para precisión interna, 
  // la UI decidirá si redondea a entero.
  const round = (val: number) => Math.round((val + Number.EPSILON) * 100) / 100;

  return {
    precio_unitario_neto: round(precio_unitario_base),
    costo_presentacion: round(costo_presentacion),
    costo_total_operativo: round(costo_total_operativo),
    precio_final_ars: round(precio_final_ars),
    detalles_tributos: detalles_tributos.map(t => ({ ...t, monto: round(t.monto) }))
  };
}

