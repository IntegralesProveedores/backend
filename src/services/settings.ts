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
  markups: { minorista: number; mayorista: number };
  shippingPriceBufferPercentage: number;
  paymentCommissionPercentage: number;
}

const FALLBACK: PricingConfig = {
  exchangeRate: 1481.94,
  embalageCost: 745.56,
  markups: { minorista: 40, mayorista: 30 },
  shippingPriceBufferPercentage: 40,
  paymentCommissionPercentage: 6.5
};

export async function getPricingConfig(env: any): Promise<PricingConfig> {
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
}
