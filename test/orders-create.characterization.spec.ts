import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleCreateOrder, handleGetOrder } from "../src/routes/orders";
import { buildOrderQuote, OrderQuoteError } from "../src/services/order-quote.service";
import { createOrderRecord, DuplicateOrderError, findOrderByIdempotencyKey } from "../src/services/orders.repository";
import { sendTransferOrderConfirmationEmail } from "../src/services/email/order-confirmation-templates";
import { verifyTurnstile } from "../src/lib/turnstile";
import { getSupabase } from "../src/services/db";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Test de caracterización de POST /orders (transferencia) y GET /orders/:id:
//           fija el comportamiento ACTUAL (status, cuerpo de la respuesta, qué se guarda,
//           qué se descuenta y qué se manda por mail) para cada camino.
// POR QUÉ:  Red de seguridad para refactorizar handleCreateOrder sin cambiar nada visible.
//           Si una respuesta, un mensaje o un argumento cambia, este test falla.
// ─────────────────────────────────────────────────────────────

vi.mock("../src/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => null) }));
vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));
vi.mock("../src/services/email/order-confirmation-templates", () => ({
  sendTransferOrderConfirmationEmail: vi.fn(async () => {})
}));
vi.mock("../src/services/order-quote.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/services/order-quote.service")>()),
  buildOrderQuote: vi.fn()
}));
vi.mock("../src/services/orders.repository", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/services/orders.repository")>()),
  findOrderByIdempotencyKey: vi.fn(),
  createOrderRecord: vi.fn()
}));

const ORDER_REF = "11111111-1111-4111-8111-111111111111";
const KEY = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

const validBody = () => ({
  payment_method: "transferencia",
  turnstile_token: "tok",
  items: [{ variant_id: "v1", quantity: 2 }],
  customer: { nombre: "Juan Pérez", email: "juan@example.com", cuit: "20-12345678-9", codigoArea: "11", celular: "12345678" },
  shipping: { method: "pickup" },
  expected_total_ars: 18000,
  idempotency_key: KEY
});

// Cotización de ejemplo: 2 packs a $10.000 de lista, sin envío. Transferencia: 10% de descuento → $18.000.
const quote = () => ({
  items: [{
    variant_id: "v1", product_id: "p1", sku: "SEM-048", product_name: "Semillera", quantity: 2,
    units_per_pack: 48, units_per_pack_master: 960, stock: 20, cost_usd_master: 19, cost_usd_master_original: 20,
    cost_currency: "USD", price_ars: 10000, price_usd: 6.67, price_ars_no_discount: 10500, price_ars_no_tax: 8264,
    image_url: "/assets/semillera.webp", subtotal_ars: 20000, subtotal_usd: 13.33, discount_percentage: 5
  }],
  taxes: [{ name: "IVA", percentage: 21, is_computable: true, is_active: true }],
  subtotalArs: 20000,
  subtotalUsd: 13.33,
  shippingArs: 0,
  packagingBoxes: [{ boxModelId: "b1", boxModelName: "Caja Chica", count: 1 }],
  embalajeArs: 1351,
  exchangeRate: 1500,
  paymentCommissionPercentage: 10,
  subtotalNoDiscountArs: 21000
});

let rpc: ReturnType<typeof vi.fn>;
let deleteEq: ReturnType<typeof vi.fn>;

function mockDb(stockError: { message: string } | null = null) {
  rpc = vi.fn(async () => ({ error: stockError }));
  deleteEq = vi.fn(async () => ({ error: null }));
  vi.mocked(getSupabase).mockReturnValue({
    rpc,
    from: vi.fn(() => ({ delete: vi.fn(() => ({ eq: deleteEq })) }))
  } as any);
}

async function call(body: unknown, raw = false) {
  const response = await handleCreateOrder({
    request: new Request("https://api.test/orders", { method: "POST", body: raw ? (body as string) : JSON.stringify(body) }),
    env: {}
  });
  const json = (await response.json()) as Record<string, unknown>;
  delete json.error_id; // aleatorio
  return { status: response.status, json };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(crypto, "randomUUID").mockReturnValue(ORDER_REF);
  vi.mocked(verifyTurnstile).mockResolvedValue(null);
  vi.mocked(findOrderByIdempotencyKey).mockResolvedValue(null);
  vi.mocked(buildOrderQuote).mockResolvedValue(quote() as any);
  vi.mocked(createOrderRecord).mockResolvedValue({ id: "order-1" } as any);
  mockDb();
});

describe("POST /orders — validación (mismo mensaje y status que hoy)", () => {
  const cases: Array<[string, unknown, number, string, boolean?]> = [
    ["JSON inválido", "{roto", 400, "Invalid JSON body", true],
    ["medio de pago distinto", { ...validBody(), payment_method: "mercadopago" }, 400, "payment_method must be 'transferencia'; use /payments/create for Mercado Pago"],
    ["envío sin método", { ...validBody(), shipping: {} }, 400, "shipping.method must be pickup, delivery, or coordinar"],
    ["delivery incompleto", { ...validBody(), shipping: { method: "delivery", address: { postal_code: "1000" } } }, 400, "Delivery shipping requires street, street_number, postal_code, province, and locality outside CABA"],
    ["sin ítems", { ...validBody(), items: [] }, 400, "items must contain between 1 and 50 entries"],
    ["más de 50 ítems", { ...validBody(), items: Array.from({ length: 51 }, () => ({ variant_id: "v", quantity: 1 })) }, 400, "items must contain between 1 and 50 entries"],
    ["mail inválido", { ...validBody(), customer: { ...validBody().customer, email: "no-es-mail" } }, 400, "customer.email is invalid"],
    ["sin cliente", { ...validBody(), customer: undefined }, 400, "customer.email is invalid"],
    ["nombre vacío", { ...validBody(), customer: { ...validBody().customer, nombre: " " } }, 400, "customer.nombre is required and must be a reasonable length"],
    ["CUIT corto", { ...validBody(), customer: { ...validBody().customer, cuit: "123" } }, 400, "customer.cuit must contain exactly 11 digits"],
    ["cantidad decimal", { ...validBody(), items: [{ variant_id: "v1", quantity: 1.5 }] }, 400, "Invalid item at index 0"],
    ["ítem sin variante", { ...validBody(), items: [{ variant_id: "v1", quantity: 1 }, { quantity: 1 }] }, 400, "Invalid item at index 1"],
    ["key inválida", { ...validBody(), idempotency_key: "no-uuid" }, 400, "idempotency_key must be a valid UUID"],
    ["total esperado inválido", { ...validBody(), expected_total_ars: -1 }, 400, "expected_total_ars must be a non-negative number"]
  ];

  for (const [name, body, status, message, raw] of cases) {
    it(name, async () => {
      const result = await call(body, raw);
      expect(result).toEqual({ status, json: { error: message, status } });
      expect(createOrderRecord).not.toHaveBeenCalled();
    });
  }

  it("el captcha se verifica después del medio de pago y su respuesta sale tal cual", async () => {
    vi.mocked(verifyTurnstile).mockResolvedValue(new Response(JSON.stringify({ error: "Captcha token is required", status: 400 }), { status: 400 }));
    expect(await call(validBody())).toEqual({ status: 400, json: { error: "Captcha token is required", status: 400 } });
    expect(buildOrderQuote).not.toHaveBeenCalled();
  });
});

describe("POST /orders — idempotencia", () => {
  it("misma key y mismos ítems: devuelve la orden existente sin crear otra", async () => {
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue({
      id: "old", external_reference: "ref-old", status: "pending",
      order_items: [{ product_variant_id: "v1", quantity: 2 }]
    });
    expect(await call(validBody())).toEqual({ status: 200, json: { order_ref: "ref-old", duplicate: true } });
    expect(buildOrderQuote).not.toHaveBeenCalled();
  });

  it("misma key con otros ítems: 409 idempotency_conflict", async () => {
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue({
      id: "old", external_reference: "ref-old", status: "pending",
      order_items: [{ product_variant_id: "v1", quantity: 5 }]
    });
    expect(await call(validBody())).toEqual({ status: 409, json: { error: "idempotency_conflict", status: 409 } });
  });

  it("dos requests simultáneos chocan al insertar: se trata como duplicado", async () => {
    vi.mocked(createOrderRecord).mockRejectedValue(new DuplicateOrderError("old", "ref-old"));
    expect(await call(validBody())).toEqual({ status: 200, json: { order_ref: "ref-old", duplicate: true } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe("POST /orders — cotización y total", () => {
  it("error de cotización (ej. sin stock): 400 con el mensaje de la cotización", async () => {
    vi.mocked(buildOrderQuote).mockRejectedValue(new OrderQuoteError("Insufficient stock for variant: SEM-048"));
    expect(await call(validBody())).toEqual({ status: 400, json: { error: "Insufficient stock for variant: SEM-048", status: 400 } });
  });

  it("el total cambió: 409 price_changed con los dos totales", async () => {
    expect(await call({ ...validBody(), expected_total_ars: 15000 })).toEqual({
      status: 409,
      json: { error: "price_changed", status: 409, current_total_ars: 18000, expected_total_ars: 15000 }
    });
    expect(createOrderRecord).not.toHaveBeenCalled();
  });

  it("sin expected_total_ars (frontend viejo) no valida el total", async () => {
    const { expected_total_ars: _omit, ...body } = validBody();
    expect((await call(body)).status).toBe(200);
  });

  it("error inesperado: 500 genérico", async () => {
    vi.mocked(buildOrderQuote).mockRejectedValue(new Error("supabase caído"));
    expect(await call(validBody())).toEqual({ status: 500, json: { error: "Unable to create order", status: 500 } });
  });
});

describe("POST /orders — orden creada", () => {
  it("guarda la orden, descuenta stock, manda el mail y responde el detalle", async () => {
    const result = await call(validBody());

    expect(createOrderRecord).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createOrderRecord).mock.calls[0].slice(1)).toEqual([
      validBody().customer,
      [{ variant_id: "v1", product_id: "p1", sku: "SEM-048", product_name: "Semillera", quantity: 2, units_per_pack: 48, units_per_pack_master: 960, unit_price: 10000 }],
      20000,
      1500,
      ORDER_REF,
      { method: "pickup" },
      0,
      1351,
      "transferencia",
      10,
      2000,
      KEY
    ]);

    expect(rpc).toHaveBeenCalledWith("decrement_order_stock", { p_order_id: "order-1" });
    expect(deleteEq).not.toHaveBeenCalled();

    expect(sendTransferOrderConfirmationEmail).toHaveBeenCalledWith({}, {
      orderRef: ORDER_REF,
      customer: validBody().customer,
      items: [{ product_name: "Semillera", sku: "SEM-048", quantity: 2, units_per_pack: 48, subtotal_ars: 20000, price_ars_no_discount: 10500, price_ars_no_tax: 8264, image_url: "/assets/semillera.webp" }],
      shipping: { method: "pickup" },
      shippingAmountArs: 0,
      packagingBoxes: [{ boxModelId: "b1", boxModelName: "Caja Chica", count: 1 }],
      totalArs: 18000,
      volumeDiscountPercentage: 5,
      vatLabel: "IVA Incluido",
      transferDiscount: { percentage: 10, amountArs: 2000 }
    });

    expect(result).toEqual({
      status: 200,
      json: {
        items: [{
          variant_id: "v1", sku: "SEM-048", product_name: "Semillera", quantity: 2, units_per_pack: 48, stock: 20,
          cost_usd_master: 19, price_ars: 10000, price_usd: 6.67, subtotal_ars: 20000, subtotal_usd: 13.33,
          price_ars_no_discount: 10500,
          product: { id: "p1", name: "Semillera", cost_usd: 20, units_per_pack_master: 960 }
        }],
        total_ars: 18000,
        shipping_ars: 0,
        embalaje_ars: 1351,
        total_usd: 12,
        exchange_rate: 1500,
        order_ref: ORDER_REF,
        payment_method: "transferencia",
        payment_discount_percentage: 10,
        payment_discount_amount: 2000,
        customer: validBody().customer
      }
    });
  });

  it("IVA no computable: el mail dice 'IVA no incluido'", async () => {
    vi.mocked(buildOrderQuote).mockResolvedValue({ ...quote(), taxes: [{ name: "IVA", percentage: 21, is_computable: false, is_active: true }] } as any);
    await call(validBody());
    expect(vi.mocked(sendTransferOrderConfirmationEmail).mock.calls[0][1].vatLabel).toBe("IVA no incluido");
  });

  it("no alcanza el stock: borra la orden, no manda mail y responde 409", async () => {
    mockDb({ message: "insufficient stock" });
    expect(await call(validBody())).toEqual({ status: 409, json: { error: "Insufficient stock to complete the order", status: 409 } });
    expect(deleteEq).toHaveBeenCalledWith("id", "order-1");
    expect(sendTransferOrderConfirmationEmail).not.toHaveBeenCalled();
  });
});

describe("GET /orders/:id — detalle público de la orden", () => {
  function mockOrderTables(order: { data: unknown; error: unknown }, items: { data: unknown; error: unknown }) {
    vi.mocked(getSupabase).mockReturnValue({
      from: vi.fn((table: string) => table === "orders"
        ? { select: vi.fn(() => ({ eq: vi.fn(() => ({ single: vi.fn(async () => order) })) })) }
        : { select: vi.fn(() => ({ eq: vi.fn(async () => items) })) })
    } as any);
  }

  async function get(id: string) {
    const response = await handleGetOrder({ env: {}, params: { id }, request: new Request(`https://api.test/orders/${id}`) });
    const json = (await response.json()) as Record<string, unknown>;
    delete json.error_id;
    return { status: response.status, json };
  }

  it("id que no es UUID: 400", async () => {
    expect(await get("x")).toEqual({ status: 400, json: { error: "Invalid order id", status: 400 } });
  });

  it("orden inexistente: 404", async () => {
    mockOrderTables({ data: null, error: { message: "no rows" } }, { data: [], error: null });
    expect(await get(ORDER_REF)).toEqual({ status: 404, json: { error: "Order not found", status: 404 } });
  });

  it("falla la lectura de ítems: 500", async () => {
    mockOrderTables({ data: { status: "pending" }, error: null }, { data: null, error: { message: "boom" } });
    expect(await get(ORDER_REF)).toEqual({ status: 500, json: { error: "Unable to load order details", status: 500 } });
  });

  it("devuelve estado, ítems y totales sin datos personales", async () => {
    mockOrderTables(
      {
        data: {
          status: "pending", payment_status: "pending", shipping_status: null, subtotal_amount: 20000, shipping_amount: 0,
          total_amount: 18000, payment_discount_percentage: 10, payment_discount_amount: 2000, external_reference: "ref-1",
          created_at: "2026-09-24T00:00:00Z"
        },
        error: null
      },
      { data: [{ id: "i1", product_variant_id: "v1", quantity: 2, unit_price: 10000 }], error: null }
    );
    expect(await get(ORDER_REF)).toEqual({
      status: 200,
      json: {
        order_ref: "ref-1", status: "pending", payment_status: "pending", shipping_status: null, created_at: "2026-09-24T00:00:00Z",
        items: [{ id: "i1", variant_id: "v1", quantity: 2, unit_price: 10000, subtotal: 20000 }],
        totals: { subtotal_ars: 20000, shipping_ars: 0, total_ars: 18000, payment_discount_percentage: 10, payment_discount_amount: 2000 }
      }
    });
  });
});
