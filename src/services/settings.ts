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

  return Number(data.usd_exchange_rate) || 1;
}

async function refreshExchangeRate(env: any): Promise<number> {
  let rate = 1;
  try {
    const res = await fetch("https://dolarapi.com/v1/dolares/oficial");
    const data: any = await res.json();
    rate = Number(data?.venta) || 1;

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
    return rate;
  }
}

function refreshExchangeRateBackground(env: any): void {
  void refreshExchangeRate(env).catch((e) => {
    console.error("Error en segundo plano al refrescar el tipo de cambio desde DolarAPI:", e);
  });
}

export interface PricingConfig {
  exchangeRate: number;
  embalageCost: number;
  packagingCost: number;
  markups: { minorista: number; mayorista: number };
  shippingPriceBufferPercentage: number;
  paymentCommissionPercentage: number;
}

const FALLBACK: PricingConfig = {
  exchangeRate: 1481.94,
  embalageCost: 745.56,
  packagingCost: 0,
  markups: { minorista: 40, mayorista: 30 },
  shippingPriceBufferPercentage: 40,
  paymentCommissionPercentage: 6.5
};

export async function getPricingConfig(env: any): Promise<PricingConfig> {
  return getCached(env, "pricing_settings", async () => {
    try {
      const supabase = getSupabase(env);
      const { data, error } = await supabase
        .from("pricing_settings")
        .select("key, value")
        .eq("is_active", true);
      if (error || !data || data.length === 0) return FALLBACK;
      const map = new Map<string, number>(data.map((r: any) => [r.key, Number(r.value)]));
      return {
        exchangeRate: map.get('usd_exchange_rate') ?? FALLBACK.exchangeRate,
        embalageCost: map.get('embalaje_cost') ?? FALLBACK.embalageCost,
        packagingCost: map.get('packaging_cost') ?? FALLBACK.packagingCost,
        markups: {
          minorista: map.get('markup_minorista') ?? FALLBACK.markups.minorista,
          mayorista: map.get('markup_mayorista') ?? FALLBACK.markups.mayorista
        },
        shippingPriceBufferPercentage: map.get('shipping_price_buffer_percentage') ?? FALLBACK.shippingPriceBufferPercentage,
        paymentCommissionPercentage: map.get('payment_commission_percentage') ?? FALLBACK.paymentCommissionPercentage
      };
    } catch (e) {
      console.error("Excepcion al obtener pricing config desde base de datos, usando fallback:", e);
      return FALLBACK;
    }
  });
}

export interface VolumeDiscountRule {
  min: number;
  factor: number;
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
  return getCached(env, "pricing_volume_discounts", async () => {
    const supabase = getSupabase(env);
    const { data, error } = await supabase
      .from("pricing_volume_discounts")
      .select("min_quantity, factor")
      .order("min_quantity", { ascending: false });
    if (error) throw new Error(`Unable to load discounts: ${error.message}`);
    return (data ?? []).map((d: any) => ({
      min: Number(d.min_quantity),
      factor: Number(d.factor)
    }));
  });
}
