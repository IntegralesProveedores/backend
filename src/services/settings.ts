import { getSupabase } from "./db";
import { TaxRule } from "../lib/pricing";

// TTL corto: mantiene el catálogo fresco (cambios de precios/impuestos se
// ven en como máximo este tiempo) mientras evita golpear Supabase en cada
// request de listado de productos. 60s es el mínimo que acepta Cloudflare
// KV (expirationTtl < 60 es rechazado), así que es el valor más bajo
// posible dentro del rango de 30-60s pedido.
const PRICING_CACHE_TTL_SECONDS = 60;

/**
 * Envoltorio genérico de cacheo con KV (env.PRICING_CACHE). Si el binding
 * no está disponible (p.ej. tests sin ese binding) o falla la lectura/
 * escritura, simplemente no cachea -nunca bloquea el flujo por un error
 * de caché. La invalidación es por expiración (TTL), no activa: no hay
 * un flujo de escritura de estos datos desde este mismo Worker que
 * amerite invalidar el caché a mano.
 */
async function getCached<T>(env: any, key: string, fetcher: () => Promise<T>): Promise<T> {
  const cache = env?.PRICING_CACHE;
  if (cache) {
    try {
      const cached = await cache.get(key, "json");
      if (cached !== null) return cached as T;
    } catch (e) {
      console.error(`Unable to read PRICING_CACHE key "${key}":`, e);
    }
  }

  const value = await fetcher();

  if (cache) {
    try {
      await cache.put(key, JSON.stringify(value), { expirationTtl: PRICING_CACHE_TTL_SECONDS });
    } catch (e) {
      console.error(`Unable to write PRICING_CACHE key "${key}":`, e);
    }
  }

  return value;
}

export async function getExchangeRate(env: any): Promise<number> {
  const supabase = getSupabase(env);

  const { data, error } = await supabase
    .from("settings")
    .select("usd_exchange_rate, updated_at")
    .eq("id", true)
    .single();

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  const isStale = data && new Date(data.updated_at) < oneHourAgo;

  if (error || !data || isStale) {
    return await refreshExchangeRate(env);
  }

  return Number(data.usd_exchange_rate) || FALLBACK_EXCHANGE_RATE;
}

async function refreshExchangeRate(env: any): Promise<number> {
  // CUIDADO: nunca persistir un tipo de cambio inválido. Un valor de 1 en
  // pricing_settings hunde todos los precios hasta el próximo refresh exitoso
  // (que recién ocurre una hora después). Ante cualquier falla se devuelve el
  // último valor guardado, sin escribir nada.
  try {
    const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
    if (!res.ok) throw new Error(`DolarAPI respondió HTTP ${res.status}`);
    const data: any = await res.json();
    const rate = Number(data?.venta);
    if (!Number.isFinite(rate) || rate <= 0) throw new Error("DolarAPI devolvió un tipo de cambio inválido");

    const supabase = getSupabase(env);
    const { error } = await supabase.rpc("update_exchange_rate", {
      new_rate: rate
    });

    if (error) {
      console.warn("No se pudo persistir el tipo de cambio en la DB mediante RPC:", error.message);
    }
    await supabase.from("pricing_settings")
      .update({ value: rate, updated_at: new Date().toISOString() })
      .eq("key", "usd_exchange_rate");

    return rate;
  } catch (e) {
    console.error("Error critico al refrescar el tipo de cambio desde DolarAPI:", e);
    return await getStoredExchangeRate(env);
  }
}

async function getStoredExchangeRate(env: any): Promise<number> {
  try {
    const { data } = await getSupabase(env)
      .from("settings")
      .select("usd_exchange_rate")
      .eq("id", true)
      .single();
    const stored = Number(data?.usd_exchange_rate);
    return Number.isFinite(stored) && stored > 0 ? stored : FALLBACK_EXCHANGE_RATE;
  } catch {
    return FALLBACK_EXCHANGE_RATE;
  }
}

export interface PricingConfig {
  exchangeRate: number;
  embalageCost: number;
  packagingCost: number;
  markups: { minorista: number; mayorista: number };
  shippingPriceBufferPercentage: number;
  paymentCommissionPercentage: number;
}

export class PricingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingConfigError";
  }
}

/**
 * CUIDADO: no hay valores de respaldo para precios. Si pricing_settings no se
 * puede leer o tiene un valor inválido se corta con error (y no se cachea): un
 * respaldo fijo cotizaba y cobraba órdenes con dólar, markup, envío y comisión
 * viejos durante todo el TTL del caché. Solo el tipo de cambio tiene un
 * último recurso (FALLBACK_EXCHANGE_RATE), y únicamente para /settings.
 */
const FALLBACK_EXCHANGE_RATE = 1481.94;

async function getPricingSettingsMap(env: any): Promise<Record<string, number>> {
  return getCached(env, "pricing_settings_v2", async () => {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("pricing_settings")
      .select("key, value")
      .eq("is_active", true);
    if (error) throw new PricingConfigError(`Unable to load pricing settings: ${error.message}`);
    if (!data || data.length === 0) throw new PricingConfigError("pricing_settings is empty");
    return Object.fromEntries(data.map((row: any) => [String(row.key), Number(row.value)]));
  });
}

/** Valor numérico finito y no negativo (o > 0 si positive=true); si falta o es inválido, error. */
function requireSetting(settings: Record<string, number>, key: string, positive = false): number {
  const value = settings[key];
  if (!Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new PricingConfigError(`pricing_settings "${key}" is missing or invalid`);
  }
  return value;
}

export async function getPricingConfig(env: any): Promise<PricingConfig> {
  const settings = await getPricingSettingsMap(env);
  return {
    exchangeRate: requireSetting(settings, "usd_exchange_rate", true),
    embalageCost: requireSetting(settings, "embalaje_cost"),
    // packaging_cost y markup_mayorista son opcionales: sin fila valen 0.
    packagingCost: Number.isFinite(settings["packaging_cost"]) && settings["packaging_cost"] >= 0 ? settings["packaging_cost"] : 0,
    markups: {
      minorista: requireSetting(settings, "markup_minorista"),
      mayorista: Number.isFinite(settings["markup_mayorista"]) && settings["markup_mayorista"] >= 0 ? settings["markup_mayorista"] : 0
    },
    shippingPriceBufferPercentage: requireSetting(settings, "shipping_price_buffer_percentage"),
    paymentCommissionPercentage: requireSetting(settings, "payment_commission_percentage")
  };
}

/** Buffer de envío, sin exigir el resto de la config de precios. */
export async function getShippingPriceBufferPercentage(env: any): Promise<number> {
  return requireSetting(await getPricingSettingsMap(env), "shipping_price_buffer_percentage");
}

export interface VolumeDiscountRule {
  min: number;
  /** Descuento sobre el costo del producto, en % (0-100). */
  discount_percentage: number;
}

export async function getCachedTaxes(env: any): Promise<TaxRule[]> {
  return getCached(env, "pricing_taxes", async () => {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("pricing_taxes")
      .select("name, percentage, is_computable, is_active")
      .eq("is_active", true);
    if (error) throw new Error(`Unable to load taxes: ${error.message}`);
    return (data ?? []).map((t: any): TaxRule => ({
      name: t.name,
      percentage: Number(t.percentage),
      is_computable: t.is_computable,
      is_active: t.is_active
    }));
  });
}

export async function getCachedVolumeDiscounts(env: any): Promise<VolumeDiscountRule[]> {
  return getCached(env, "pricing_volume_discounts_v2", async () => {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("pricing_volume_discounts")
      .select("min_quantity, discount_percentage")
      .order("min_quantity", { ascending: false });
    if (error) throw new Error(`Unable to load discounts: ${error.message}`);
    return (data ?? []).map((d: any) => ({
      min: Number(d.min_quantity),
      discount_percentage: Number(d.discount_percentage)
    }));
  });
}
