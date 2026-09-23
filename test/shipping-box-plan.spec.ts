import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShippingBoxPlan } from "../src/services/shipping.service";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

const getSupabaseMock = vi.mocked(getSupabase);

/** % del medio de pago que el mock devuelve en pricing_settings (0 = precios de envío "planos"). */
let paymentFeePercentage = 0;

const BOX_ASSIGNMENTS = [
  { box_model_id: "small", min_quantity: 1, max_quantity: 333 },
  { box_model_id: "medium", min_quantity: 334, max_quantity: 666 },
  { box_model_id: "large", min_quantity: 667, max_quantity: 1000 }
];

const BOX_MODELS = [
  { id: "small", name: "Caja Chica", width_cm: 20, length_cm: 20, height_cm: 20, weight_kg: 1 },
  { id: "medium", name: "Caja Mediana", width_cm: 30, length_cm: 25, height_cm: 30, weight_kg: 2 },
  { id: "large", name: "Caja Grande", width_cm: 40, length_cm: 30, height_cm: 60, weight_kg: 4 }
];

const ratesForZone = (zoneName: string) => ["CABA_PBA", "RESTO_PAIS"].includes(zoneName)
  ? [
      { box_model_id: "small", price_ars: zoneName === "CABA_PBA" ? 13000 : 17000 },
      { box_model_id: "medium", price_ars: zoneName === "CABA_PBA" ? 19000 : 31000 },
      { box_model_id: "large", price_ars: zoneName === "CABA_PBA" ? 24000 : 55000 }
    ]
  : [];

/**
 * resolveShippingBoxPlan hace varias queries independientes: primero
 * getPricingConfig (tabla pricing_settings) para resolver el buffer de
 * envío, y por cada grupo de producto: pricing_shipping_box_assignments,
 * y luego -en paralelo vía Promise.all- pricing_shipping_rates y
 * pricing_shipping_box_models. Cada .from(table) debe devolver su propio
 * query builder aislado -no uno compartido- para no pisar el estado de
 * las llamadas concurrentes. El buffer se fija en 0% para poder afirmar
 * sobre los mismos price_ars "planos" que devuelven las tarifas mockeadas.
 */
function makeQuery(table: string) {
  const filters: Record<string, unknown> = {};
  const query: any = {
    select: vi.fn(() => query),
    eq: vi.fn((field: string, value: unknown) => {
      filters[field] = value;
      return query;
    }),
    in: vi.fn(() => query),
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      let data: unknown[] = [];
      if (table === "pricing_settings") {
        data = [
          { key: "shipping_price_buffer_percentage", value: 0 },
          { key: "payment_commission_percentage", value: paymentFeePercentage }
        ];
      } else if (table === "pricing_shipping_box_assignments") {
        data = BOX_ASSIGNMENTS;
      } else if (table === "pricing_shipping_rates") {
        data = ratesForZone(String(filters["zone_name"] ?? ""));
      } else if (table === "pricing_shipping_box_models") {
        data = BOX_MODELS;
      }
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    }
  };
  return query;
}

function mockSupabase() {
  getSupabaseMock.mockImplementation(() => ({
    from: vi.fn((table: string) => makeQuery(table))
  }) as any);
}

describe("resolveShippingBoxPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase();
  });

  it("usa una Caja Chica para 250 milésimos de bulto equivalente", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 250 }]);
    expect(result).toEqual({
      boxes: [expect.objectContaining({ boxModelId: "small", count: 1 })],
      totalPriceArs: 13000
    });
  });

  it("elige la Caja Mediana para 500 milésimos de bulto equivalente", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 500 }]);
    expect(result.totalPriceArs).toBe(19000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["medium", 1]]);
  });

  it("elige una Caja Grande para 1000 milésimos de bulto equivalente", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 1000 }]);
    expect(result.totalPriceArs).toBe(24000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["large", 1]]);
  });

  it("encuentra la combinación óptima para 1250 unidades", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 1250 }]);
    expect(result.totalPriceArs).toBe(37000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["small", 1], ["large", 1]]);
  });

  it("devuelve un plan vacío para 0 unidades sin consultar cajas", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", []);
    expect(result).toEqual({ boxes: [], totalPriceArs: 0 });
    expect(getSupabaseMock).not.toHaveBeenCalled();
  });

  it("falla explícitamente cuando la zona no tiene tarifas activas", async () => {
    await expect(resolveShippingBoxPlan({} as Env, "SIN_TARIFA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 50 }]))
      .rejects.toThrow('No active shipping rates found for zone "SIN_TARIFA"');
  });

  it("el envío también lleva el costo del medio de pago (10% => precio / 0,9)", async () => {
    paymentFeePercentage = 10;
    try {
      const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", [{ product_id: "00000000-0000-4000-8000-000000000001", units: 100 }]);
      expect(result.totalPriceArs).toBe(Math.round(13000 / 0.9));
    } finally {
      paymentFeePercentage = 0;
    }
  });
});
