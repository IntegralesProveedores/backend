import { getSupabase } from "./db";

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
  markups: {
    minorista: number;
    mayorista: number;
  };
}

export async function getPricingConfig(env: any): Promise<PricingConfig> {
  const fallback: PricingConfig = {
    exchangeRate: 1481.94,
    embalageCost: 745.56,
    markups: {
      minorista: 40,
      mayorista: 30
    }
  };

  const cacheKey = "pricing_config";
  const cacheTtlSeconds = 3600;
  const kv = env?.PRICING_CACHE;

  const readCachedConfig = async (): Promise<PricingConfig | null> => {
    if (!kv?.get) {
      return null;
    }

    try {
      const cached = await kv.get(cacheKey, "json") as PricingConfig | null;
      return cached ?? null;
    } catch (e) {
      console.error("Error al leer pricing_config desde KV:", e);
      return null;
    }
  };

  const persistCache = async (value: PricingConfig): Promise<void> => {
    if (!kv?.put) {
      return;
    }

    try {
      await kv.put(cacheKey, JSON.stringify(value), { expirationTtl: cacheTtlSeconds });
    } catch (e) {
      console.error("Error al guardar pricing_config en KV:", e);
    }
  };

  try {
    const supabase = getSupabase(env);

    const { data, error } = await supabase
      .from("settings")
      .select("usd_exchange_rate, updated_at, embalaje_cost, markup_minorista, markup_mayorista")
      .eq("id", true)
      .single();

    if (error || !data) {
      const cachedConfig = await readCachedConfig();
      if (cachedConfig) {
        return {
          exchangeRate: cachedConfig.exchangeRate,
          embalageCost: cachedConfig.embalageCost,
          markups: cachedConfig.markups
        };
      }

      console.warn("Error al obtener settings de Supabase, usando fallback:", error?.message);
      return fallback;
    }

    const exchangeRate = Number(data.usd_exchange_rate) || fallback.exchangeRate;
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    const isStale = new Date(data.updated_at) < oneHourAgo;

    if (isStale) {
      refreshExchangeRateBackground(env);
    }

    const embalageCost = data.embalaje_cost !== null && data.embalaje_cost !== undefined
      ? Number(data.embalaje_cost)
      : fallback.embalageCost;

    const minorista = data.markup_minorista !== null && data.markup_minorista !== undefined
      ? Number(data.markup_minorista)
      : fallback.markups.minorista;

    const mayorista = data.markup_mayorista !== null && data.markup_mayorista !== undefined
      ? Number(data.markup_mayorista)
      : fallback.markups.mayorista;

    const result: PricingConfig = {
      exchangeRate,
      embalageCost,
      markups: {
        minorista,
        mayorista
      }
    };
    await persistCache(result);
    return result;
  } catch (e) {
    const cachedConfig = await readCachedConfig();
    if (cachedConfig) {
      return {
        exchangeRate: cachedConfig.exchangeRate,
        embalageCost: cachedConfig.embalageCost,
        markups: cachedConfig.markups
      };
    }

    console.error("Excepcion al obtener pricing config desde base de datos, usando fallback:", e);
    return fallback;
  }
}
