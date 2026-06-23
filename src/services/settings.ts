import { getSupabase } from "./db";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Obtiene y gestiona el tipo de cambio oficial
// POR QUÉ:  Centraliza la lógica de cotización y persistencia (Problema B8)
// CUIDADO:  Implementa cache en DB para evitar dependencia directa de DolarAPI
// ─────────────────────────────────────────────────────────────

/**
 * Obtiene el tipo de cambio desde la base de datos (Supabase).
 * Si no existe o hay error, intenta refrescar desde DolarAPI.
 */
export async function getExchangeRate(env: any): Promise<number> {
  const supabase = getSupabase(env);
  
  const { data, error } = await supabase
    .from("settings")
    .select("usd_exchange_rate, updated_at")
    .eq("id", true)
    .single();

  // Si no hay datos o son muy viejos (más de 1 hora), refrescamos
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const isStale = data && new Date(data.updated_at) < oneHourAgo;

  if (error || !data || isStale) {
    return await refreshExchangeRate(env);
  }

  return Number(data.usd_exchange_rate) || 1;
}

/**
 * Consulta DolarAPI y actualiza la base de datos si es posible.
 * Retorna la tasa obtenida incluso si falla la actualización en DB.
 */
async function refreshExchangeRate(env: any): Promise<number> {
  let rate = 1;
  try {
    const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
    const data: any = await res.json();
    rate = Number(data?.venta) || 1;
    
    // Intentamos actualizar en la DB para cachear el valor vía RPC seguro (F1)
    const supabase = getSupabase(env);
    const { error } = await supabase.rpc('update_exchange_rate', { 
      new_rate: rate 
    });

    if (error) {
      console.warn("No se pudo persistir el tipo de cambio en la DB mediante RPC:", error.message);
    }
      
    return rate;
  } catch (e) {
    console.error("Error crítico al refrescar el tipo de cambio desde DolarAPI:", e);
    return rate; // Retornamos lo que tengamos (o el default 1)
  }
}

/** Interfaz de configuración comercial y de precios del negocio */
export interface PricingConfig {
  exchangeRate: number;
  embalageCost: number;
  markups: {
    integrales: { minorista: number; mayorista: number };
    brotalia: { minorista: number; mayorista: number };
  };
}

/**
 * Obtiene la configuración completa de cotización y markups desde Supabase.
 * @param env - entorno de Cloudflare Workers
 * @returns Promise con el objeto PricingConfig
 */
export async function getPricingConfig(env: any): Promise<PricingConfig> {
  // ─────────────────────────────────────────────────────────────
  // QUÉ HACE: Obtiene el tipo de cambio, costo de embalaje y markups por canal de Supabase.
  // POR QUÉ:  Evita la duplicación y hardcoding de configuraciones comerciales clave (Problemas B8 y F1).
  // CUIDADO:  Implementa una política estricta de fallback si falla la base de datos o devuelve valores inválidos.
  // ─────────────────────────────────────────────────────────────
  
  const fallback: PricingConfig = {
    exchangeRate: 1481.94,
    embalageCost: 745.56,
    markups: {
      integrales: { minorista: 20, mayorista: 15 },
      brotalia: { minorista: 40, mayorista: 30 }
    }
  };

  try {
    const supabase = getSupabase(env);
    
    const { data, error } = await supabase
      .from("settings")
      .select("usd_exchange_rate, updated_at, embalaje_cost, markup_integrales_minorista, markup_integrales_mayorista, markup_brotalia_minorista, markup_brotalia_mayorista")
      .eq("id", true)
      .single();

    if (error || !data) {
      console.warn("Error al obtener settings de Supabase, usando fallback:", error?.message);
      return fallback;
    }

    // Evaluamos si el tipo de cambio está stale (más de 1 hora) y tratamos de actualizarlo
    let exchangeRate = Number(data.usd_exchange_rate) || fallback.exchangeRate;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const isStale = new Date(data.updated_at) < oneHourAgo;

    if (isStale) {
      try {
        const freshRate = await refreshExchangeRate(env);
        if (freshRate > 1) {
          exchangeRate = freshRate;
        }
      } catch (e) {
        console.warn("No se pudo refrescar el tipo de cambio stale, se usa el de DB:", e);
      }
    }

    const embalageCost = data.embalaje_cost !== null && data.embalaje_cost !== undefined
      ? Number(data.embalaje_cost)
      : fallback.embalageCost;

    const markup_integrales_minorista = data.markup_integrales_minorista !== null && data.markup_integrales_minorista !== undefined
      ? Number(data.markup_integrales_minorista)
      : fallback.markups.integrales.minorista;

    const markup_integrales_mayorista = data.markup_integrales_mayorista !== null && data.markup_integrales_mayorista !== undefined
      ? Number(data.markup_integrales_mayorista)
      : fallback.markups.integrales.mayorista;

    const markup_brotalia_minorista = data.markup_brotalia_minorista !== null && data.markup_brotalia_minorista !== undefined
      ? Number(data.markup_brotalia_minorista)
      : fallback.markups.brotalia.minorista;

    const markup_brotalia_mayorista = data.markup_brotalia_mayorista !== null && data.markup_brotalia_mayorista !== undefined
      ? Number(data.markup_brotalia_mayorista)
      : fallback.markups.brotalia.mayorista;

    return {
      exchangeRate,
      embalageCost,
      markups: {
        integrales: {
          minorista: markup_integrales_minorista,
          mayorista: markup_integrales_mayorista
        },
        brotalia: {
          minorista: markup_brotalia_minorista,
          mayorista: markup_brotalia_mayorista
        }
      }
    };
  } catch (e) {
    console.error("Excepción al obtener pricing config desde base de datos, usando fallback:", e);
    return fallback;
  }
}
