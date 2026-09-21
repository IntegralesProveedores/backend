import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertExpectedTotal, PriceChangedError } from "../src/services/order-quote.service";
import { parseExpectedTotal, PaymentInputError } from "../src/lib/payment-input.validation";
import { parseIntParam } from "../src/lib/request";
import { releaseAbandonedOrders } from "../src/services/stock-release.service";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

const hasApprovedPayment = vi.fn();
vi.mock("../src/services/mercadopago.service", () => ({
  MercadoPagoService: class {
    hasApprovedPayment = hasApprovedPayment;
  }
}));

const getSupabaseMock = vi.mocked(getSupabase);

describe("total esperado", () => {
  it("sin expected_total_ars (frontend viejo) no valida", () => {
    expect(() => assertExpectedTotal(undefined, 12345)).not.toThrow();
  });

  it("acepta hasta $1 de diferencia", () => {
    expect(() => assertExpectedTotal(20262, 20262)).not.toThrow();
    expect(() => assertExpectedTotal(20261, 20262)).not.toThrow();
  });

  it("rechaza si el total cambió", () => {
    expect(() => assertExpectedTotal(20000, 20262)).toThrow(PriceChangedError);
    try {
      assertExpectedTotal(20000, 20262);
    } catch (error) {
      expect((error as PriceChangedError).currentTotalArs).toBe(20262);
      expect((error as PriceChangedError).expectedTotalArs).toBe(20000);
    }
  });

  it("parseExpectedTotal acepta ausente o número, y rechaza el resto", () => {
    expect(parseExpectedTotal(undefined)).toBeUndefined();
    expect(parseExpectedTotal(null)).toBeUndefined();
    expect(parseExpectedTotal(20262)).toBe(20262);
    expect(() => parseExpectedTotal("20262")).toThrow(PaymentInputError);
    expect(() => parseExpectedTotal(-1)).toThrow(PaymentInputError);
    expect(() => parseExpectedTotal(Number.NaN)).toThrow(PaymentInputError);
  });
});

describe("parseIntParam", () => {
  it("usa el valor por defecto si falta o no es numérico (antes daba NaN)", () => {
    expect(parseIntParam(null, 1, 1)).toBe(1);
    expect(parseIntParam("abc", 1, 1)).toBe(1);
    expect(parseIntParam("", 20, 1, 50)).toBe(20);
  });

  it("acota al rango", () => {
    expect(parseIntParam("0", 1, 1)).toBe(1);
    expect(parseIntParam("-5", 1, 1)).toBe(1);
    expect(parseIntParam("999", 20, 1, 50)).toBe(50);
    expect(parseIntParam("7", 1, 1)).toBe(7);
  });
});

/** Base falsa: cada tabla devuelve lo configurado y se registran los updates y RPC. */
function mockDatabase(config: {
  mercadopago?: Array<{ id: string; external_reference: string | null; payment_method: string }>;
  transferencia?: Array<{ id: string; external_reference: string | null; payment_method: string }>;
  transferHoldHours?: number | null;
  cancelReturnsRows?: boolean;
}) {
  const cancelled: string[] = [];
  const restored: string[] = [];
  const from = vi.fn((table: string) => {
    const filters: Record<string, unknown> = {};
    let isUpdate = false;
    const query: any = {
      select: vi.fn(() => query),
      update: vi.fn(() => {
        isUpdate = true;
        return query;
      }),
      eq: vi.fn((field: string, value: unknown) => {
        filters[field] = value;
        return query;
      }),
      not: vi.fn(() => query),
      lt: vi.fn(() => query),
      order: vi.fn(() => query),
      limit: vi.fn(() => query),
      maybeSingle: vi.fn(() =>
        Promise.resolve({ data: config.transferHoldHours ? { value: config.transferHoldHours } : null, error: null })
      ),
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        let data: unknown[] = [];
        if (table === "orders" && isUpdate) {
          const rows = config.cancelReturnsRows === false ? [] : [{ id: filters["id"] }];
          if (rows.length) cancelled.push(String(filters["id"]));
          data = rows;
        } else if (table === "orders") {
          data = (filters["payment_method"] === "mercadopago" ? config.mercadopago : config.transferencia) ?? [];
        }
        return Promise.resolve({ data, error: null }).then(resolve, reject);
      }
    };
    return query;
  });
  const rpc = vi.fn((_name: string, args: { p_order_id: string }) => {
    restored.push(args.p_order_id);
    return Promise.resolve({ data: true, error: null });
  });
  getSupabaseMock.mockReturnValue({ from, rpc } as any);
  return { cancelled, restored, rpc };
}

const ENV = { MP_ACCESS_TOKEN: "token" } as unknown as Env;
const mpOrder = (id: string) => ({ id, external_reference: `ref-${id}`, payment_method: "mercadopago" });

describe("liberación de stock de órdenes abandonadas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasApprovedPayment.mockResolvedValue(false);
  });

  it("cancela la orden de Mercado Pago vencida y devuelve el stock", async () => {
    const db = mockDatabase({ mercadopago: [mpOrder("a")] });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.released).toEqual(["a"]);
    expect(db.cancelled).toEqual(["a"]);
    expect(db.restored).toEqual(["a"]);
  });

  it("no toca una orden que Mercado Pago tiene aprobada (webhook perdido)", async () => {
    hasApprovedPayment.mockResolvedValue(true);
    const db = mockDatabase({ mercadopago: [mpOrder("a")] });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.released).toEqual([]);
    expect(result.skipped).toEqual(["a"]);
    expect(db.cancelled).toEqual([]);
    expect(db.restored).toEqual([]);
  });

  it("si Mercado Pago no responde, no cancela", async () => {
    hasApprovedPayment.mockRejectedValue(new Error("MP caído"));
    const db = mockDatabase({ mercadopago: [mpOrder("a")] });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.skipped).toEqual(["a"]);
    expect(db.cancelled).toEqual([]);
  });

  it("si la orden se pagó entre la lectura y el update, no devuelve stock", async () => {
    const db = mockDatabase({ mercadopago: [mpOrder("a")], cancelReturnsRows: false });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.released).toEqual([]);
    expect(db.restored).toEqual([]);
  });

  it("sin transfer_hold_hours no libera transferencias", async () => {
    const db = mockDatabase({
      transferencia: [{ id: "t", external_reference: null, payment_method: "transferencia" }],
      transferHoldHours: null
    });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.released).toEqual([]);
    expect(db.restored).toEqual([]);
  });

  it("con transfer_hold_hours libera las transferencias vencidas", async () => {
    const db = mockDatabase({
      transferencia: [{ id: "t", external_reference: null, payment_method: "transferencia" }],
      transferHoldHours: 72
    });
    const result = await releaseAbandonedOrders(ENV);
    expect(result.released).toEqual(["t"]);
    expect(db.restored).toEqual(["t"]);
    expect(hasApprovedPayment).not.toHaveBeenCalled();
  });
});
