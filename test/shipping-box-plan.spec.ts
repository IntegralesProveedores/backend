import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveShippingBoxPlan } from "../src/services/payment.service";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

const getSupabaseMock = vi.mocked(getSupabase);

const activeRates = (zoneName: string) => ["CABA_PBA", "RESTO_PAIS"].includes(zoneName)
  ? [
      { box_model_id: "small", price_ars: zoneName === "CABA_PBA" ? 13000 : 17000, pricing_shipping_box_models: {
        id: "small", name: "Caja Chica", width_cm: 20, length_cm: 20, height_cm: 20, weight_kg: 1,
        pricing_shipping_box_assignments: [{ max_quantity: 100 }]
      }},
      { box_model_id: "medium", price_ars: zoneName === "CABA_PBA" ? 19000 : 31000, pricing_shipping_box_models: {
        id: "medium", name: "Caja Mediana", width_cm: 30, length_cm: 25, height_cm: 30, weight_kg: 2,
        pricing_shipping_box_assignments: [{ max_quantity: 200 }]
      }},
      { box_model_id: "large", price_ars: zoneName === "CABA_PBA" ? 24000 : 55000, pricing_shipping_box_models: {
        id: "large", name: "Caja Grande", width_cm: 40, length_cm: 30, height_cm: 60, weight_kg: 4,
        pricing_shipping_box_assignments: [{ max_quantity: 600 }]
      }}
    ]
  : [];

function mockSupabase() {
  getSupabaseMock.mockImplementation(() => {
    const query: any = {
      select: vi.fn(() => query),
      eq: vi.fn(() => query),
      then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: activeRates(query.zoneName), error: null }).then(resolve)
    };
    query.eq.mockImplementation((field: string, value: unknown) => {
      if (field === "zone_name") query.zoneName = value;
      return query;
    });
    return { from: vi.fn(() => query) } as any;
  });
}

describe("resolveShippingBoxPlan", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSupabase();
  });

  it("usa una Caja Chica para 50 unidades", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", 50);
    expect(result).toEqual({
      boxes: [expect.objectContaining({ boxModelId: "small", count: 1, unitPriceArs: 13000 })],
      totalPriceArs: 13000
    });
  });

  it("elige la Caja Mediana para 150 unidades", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", 150);
    expect(result.totalPriceArs).toBe(19000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["medium", 1]]);
  });

  it("combina Caja Grande y Caja Chica para 650 unidades", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", 650);
    expect(result.totalPriceArs).toBe(37000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["small", 1], ["large", 1]]);
  });

  it("encuentra la combinación óptima para 1250 unidades", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", 1250);
    expect(result.totalPriceArs).toBe(61000);
    expect(result.boxes.map(box => [box.boxModelId, box.count])).toEqual([["small", 1], ["large", 2]]);
  });

  it("devuelve un plan vacío para 0 unidades sin consultar cajas", async () => {
    const result = await resolveShippingBoxPlan({} as Env, "CABA_PBA", 0);
    expect(result).toEqual({ boxes: [], totalPriceArs: 0 });
    expect(getSupabaseMock).not.toHaveBeenCalled();
  });

  it("falla explícitamente cuando la zona no tiene tarifas activas", async () => {
    await expect(resolveShippingBoxPlan({} as Env, "SIN_TARIFA", 50))
      .rejects.toThrow('No active shipping rates found for zone "SIN_TARIFA"');
  });
});
