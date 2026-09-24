import { describe, expect, it, vi } from "vitest";
import { findOrderByIdempotencyKey, isSameIdempotentOrder } from "../src/services/orders.repository";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

// Una orden ya creada con la key: 3 packs de A y 1 de B, pendiente.
const existing = {
  id: "order-1",
  external_reference: "ref-1",
  status: "pending",
  order_items: [
    { product_variant_id: "A", quantity: 3 },
    { product_variant_id: "B", quantity: 1 }
  ]
};

describe("reintento con la misma idempotency_key", () => {
  it("mismos ítems (en otro orden) → es el mismo intento, se reusa la orden", () => {
    expect(isSameIdempotentOrder(existing, [
      { variant_id: "B", quantity: 1 },
      { variant_id: "A", quantity: 3 }
    ])).toBe(true);
  });

  it("misma presentación repetida en dos líneas cuenta como la suma", () => {
    expect(isSameIdempotentOrder(existing, [
      { variant_id: "A", quantity: 2 },
      { variant_id: "A", quantity: 1 },
      { variant_id: "B", quantity: 1 }
    ])).toBe(true);
  });

  it("otra cantidad, otra presentación o un ítem de más/menos → conflicto", () => {
    expect(isSameIdempotentOrder(existing, [{ variant_id: "A", quantity: 4 }, { variant_id: "B", quantity: 1 }])).toBe(false);
    expect(isSameIdempotentOrder(existing, [{ variant_id: "A", quantity: 3 }, { variant_id: "C", quantity: 1 }])).toBe(false);
    expect(isSameIdempotentOrder(existing, [{ variant_id: "A", quantity: 3 }])).toBe(false);
    expect(isSameIdempotentOrder(existing, [
      { variant_id: "A", quantity: 3 }, { variant_id: "B", quantity: 1 }, { variant_id: "C", quantity: 1 }
    ])).toBe(false);
  });

  it("orden cancelada (volvió de Mercado Pago sin pagar) → conflicto aunque los ítems coincidan", () => {
    expect(isSameIdempotentOrder({ ...existing, status: "cancelled" }, [
      { variant_id: "A", quantity: 3 },
      { variant_id: "B", quantity: 1 }
    ])).toBe(false);
  });

  it("findOrderByIdempotencyKey trae estado e ítems para poder comparar", async () => {
    const select = vi.fn(() => ({ eq: vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve({ data: existing, error: null })) })) }));
    vi.mocked(getSupabase).mockReturnValue({ from: vi.fn(() => ({ select })) } as any);
    await expect(findOrderByIdempotencyKey({} as any, "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11")).resolves.toEqual(existing);
    expect(select).toHaveBeenCalledWith("id, external_reference, status, order_items(product_variant_id, quantity)");
  });
});
