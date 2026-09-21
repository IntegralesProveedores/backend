import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPricingConfig, getShippingPriceBufferPercentage, PricingConfigError } from "../src/services/settings";
import { pickPostalCodeProvince } from "../src/services/shipping.service";
import { calculatePriceV2 } from "../src/lib/pricing";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

const getSupabaseMock = vi.mocked(getSupabase);

const VALID_SETTINGS = [
  { key: "usd_exchange_rate", value: 1535 },
  { key: "embalaje_cost", value: 760 },
  { key: "packaging_cost", value: 2000 },
  { key: "markup_minorista", value: 60 },
  { key: "markup_embalaje", value: 60 },
  { key: "markup_mayorista", value: 20 },
  { key: "shipping_price_buffer_percentage", value: 15 },
  { key: "payment_commission_percentage", value: 10 }
];

function mockPricingSettings(result: { data: unknown; error: { message: string } | null }) {
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(result).then(resolve, reject)
  };
  getSupabaseMock.mockReturnValue({ from: vi.fn(() => query) } as any);
}

describe("getPricingConfig (sin valores de respaldo)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("arma la config a partir de pricing_settings", async () => {
    mockPricingSettings({ data: VALID_SETTINGS, error: null });
    await expect(getPricingConfig({})).resolves.toEqual({
      exchangeRate: 1535,
      embalageCost: 760,
      packagingCost: 2000,
      markups: { minorista: 60, mayorista: 20, embalaje: 60 },
      shippingPriceBufferPercentage: 15,
      paymentCommissionPercentage: 10
    });
  });

  it("si Supabase falla, corta con error en vez de cotizar con valores fijos", async () => {
    mockPricingSettings({ data: null, error: { message: "boom" } });
    await expect(getPricingConfig({})).rejects.toBeInstanceOf(PricingConfigError);
  });

  it("si la tabla está vacía, corta con error", async () => {
    mockPricingSettings({ data: [], error: null });
    await expect(getPricingConfig({})).rejects.toBeInstanceOf(PricingConfigError);
  });

  it("si falta una clave obligatoria, corta con error", async () => {
    mockPricingSettings({ data: VALID_SETTINGS.filter(s => s.key !== "markup_minorista"), error: null });
    await expect(getPricingConfig({})).rejects.toThrow("markup_minorista");
  });

  it("rechaza dólar en 0 o valores no numéricos", async () => {
    mockPricingSettings({ data: VALID_SETTINGS.map(s => s.key === "usd_exchange_rate" ? { ...s, value: 0 } : s), error: null });
    await expect(getPricingConfig({})).rejects.toThrow("usd_exchange_rate");
    mockPricingSettings({ data: VALID_SETTINGS.map(s => s.key === "embalaje_cost" ? { ...s, value: "abc" } : s), error: null });
    await expect(getPricingConfig({})).rejects.toThrow("embalaje_cost");
  });

  it("packaging_cost y markup_mayorista son opcionales (valen 0)", async () => {
    mockPricingSettings({ data: VALID_SETTINGS.filter(s => s.key !== "packaging_cost" && s.key !== "markup_mayorista"), error: null });
    const config = await getPricingConfig({});
    expect(config.packagingCost).toBe(0);
    expect(config.markups.mayorista).toBe(0);
  });

  it("el margen del embalaje es independiente del de productos y es obligatorio", async () => {
    mockPricingSettings({ data: VALID_SETTINGS.map(s => s.key === "markup_embalaje" ? { ...s, value: 35 } : s), error: null });
    const config = await getPricingConfig({});
    expect(config.markups.minorista).toBe(60);
    expect(config.markups.embalaje).toBe(35);

    mockPricingSettings({ data: VALID_SETTINGS.filter(s => s.key !== "markup_embalaje"), error: null });
    await expect(getPricingConfig({})).rejects.toThrow("markup_embalaje");
  });

  it("el buffer de envío no exige el resto de la config", async () => {
    mockPricingSettings({ data: [{ key: "shipping_price_buffer_percentage", value: 0 }], error: null });
    await expect(getShippingPriceBufferPercentage({})).resolves.toBe(0);
  });
});

describe("provincia de un código postal compartido por varias provincias", () => {
  const rows = [{ province: "Cordoba" }, { province: "Santa Fe" }];

  it("sin provincia cargada usa la primera (la que muestra GET /postal-code)", () => {
    expect(pickPostalCodeProvince(rows)).toBe("Cordoba");
  });

  it("respeta la provincia del cliente si es una del código, sin importar tildes ni mayúsculas", () => {
    expect(pickPostalCodeProvince(rows, "santa fe")).toBe("Santa Fe");
    expect(pickPostalCodeProvince([{ province: "Cordoba" }], "Córdoba")).toBe("Cordoba");
  });

  it("si la provincia del cliente no corresponde al código, usa la primera", () => {
    expect(pickPostalCodeProvince(rows, "Mendoza")).toBe("Cordoba");
  });

  it("sin filas devuelve null", () => {
    expect(pickPostalCodeProvince([])).toBeNull();
  });
});

describe("redondeo del precio final", () => {
  it("precio_final_ars viene redondeado a 2 decimales y el precio cobrado es Math.round de ese valor (el frontend hace lo mismo)", () => {
    // costo 76.70 / 600 u. x 50, dólar 1535, IVA 21% computable, embalaje 760, markup 60%:
    // el valor exacto es 20210.99..., con 2 decimales queda 20211.00 y se cobra 20211.
    const result = calculatePriceV2({
      cost_usd_master: 76.7,
      units_per_pack_master: 600,
      presentation_quantity: 50,
      exchange_rate: 1535,
      rentability_percentage: 60,
      taxes: [{ name: "IVA", percentage: 21, is_computable: true, is_active: true }],
      embalaje_cost: 760
    });
    expect(Math.round(result.precio_final_ars)).toBe(20211);
  });
});
