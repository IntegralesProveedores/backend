import { describe, expect, it, vi } from "vitest";
import { handleGetOrderPaymentState, toOrderPaymentState } from "../src/routes/orders";
import { getSupabase } from "../src/services/db";

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));

const getSupabaseMock = vi.mocked(getSupabase);
const REF = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

function mockOrder(result: { data: unknown; error: unknown }) {
  const eq = vi.fn(() => ({ maybeSingle: vi.fn(() => Promise.resolve(result)) }));
  const select = vi.fn(() => ({ eq }));
  getSupabaseMock.mockReturnValue({ from: vi.fn(() => ({ select })) } as any);
  return { select, eq };
}

function call(externalReference: string) {
  return handleGetOrderPaymentState({
    env: {},
    params: { externalReference },
    request: new Request(`https://api.test/orders/status/${externalReference}`)
  });
}

describe("toOrderPaymentState", () => {
  it("aprobado por payment_status o por status paid", () => {
    expect(toOrderPaymentState({ status: "pending", payment_status: "approved" })).toBe("approved");
    expect(toOrderPaymentState({ status: "paid", payment_status: null })).toBe("approved");
  });

  it("rechazado si la orden se canceló o Mercado Pago la rechazó", () => {
    expect(toOrderPaymentState({ status: "cancelled", payment_status: "cancelled" })).toBe("rejected");
    expect(toOrderPaymentState({ status: "pending", payment_status: "rejected" })).toBe("rejected");
    expect(toOrderPaymentState({ status: "pending", payment_status: "charged_back" })).toBe("rejected");
  });

  it("pendiente mientras no llega el webhook o el pago está en proceso", () => {
    expect(toOrderPaymentState({ status: "pending", payment_status: "pending" })).toBe("pending");
    expect(toOrderPaymentState({ status: "pending", payment_status: "in_process" })).toBe("pending");
  });
});

describe("GET /orders/status/:externalReference", () => {
  it("rechaza un N° de orden que no es UUID sin consultar la base", async () => {
    getSupabaseMock.mockClear();
    const response = await call("no-es-un-uuid");
    expect(response.status).toBe(400);
    expect(getSupabaseMock).not.toHaveBeenCalled();
  });

  it("404 si la orden no existe", async () => {
    mockOrder({ data: null, error: null });
    expect((await call(REF)).status).toBe(404);
  });

  it("devuelve solo el estado resumido, sin datos personales ni montos", async () => {
    const { select, eq } = mockOrder({ data: { status: "paid", payment_status: "approved" }, error: null });
    const response = await call(REF);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ payment: "approved" });
    expect(select).toHaveBeenCalledWith("status, payment_status");
    expect(eq).toHaveBeenCalledWith("external_reference", REF);
  });

  it("500 si falla la base", async () => {
    mockOrder({ data: null, error: { message: "boom" } });
    expect((await call(REF)).status).toBe(500);
  });
});
