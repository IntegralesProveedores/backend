import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleCreatePayment } from "../src/routes/payments";
import { handleMercadoPagoWebhook } from "../src/routes/webhooks";
import { buildOrderQuote } from "../src/services/order-quote.service";
import { createOrderRecord, DuplicateOrderError, findOrderByIdempotencyKey } from "../src/services/orders.repository";
import { sendMercadoPagoOrderConfirmationEmail } from "../src/services/email/order-confirmation-templates";
import { getSupabase } from "../src/services/db";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Test de caracterización de Mercado Pago: POST /payments/create (crear el pago)
//           y POST /api/webhooks/mercadopago (procesar el pago notificado). Fija las
//           respuestas, cada operación contra la base (en orden, con sus datos) y el
//           pedido exacto que se manda a Mercado Pago.
// POR QUÉ:  Red de seguridad para separar "crear pago" y "procesar webhook" en servicios
//           distintos sin cambiar comportamiento. Se simula el cliente HTTP de Mercado Pago
//           y Supabase, no las clases de negocio, así el test sobrevive a la refactorización.
// ─────────────────────────────────────────────────────────────

const mp = {
  createPreference: vi.fn(),
  getPayment: vi.fn(),
  validateWebhookSignature: vi.fn(),
  hasApprovedPayment: vi.fn()
};

vi.mock("../src/services/mercadopago.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/services/mercadopago.service")>()),
  MercadoPagoService: class {
    createPreference = mp.createPreference;
    getPayment = mp.getPayment;
    validateWebhookSignature = mp.validateWebhookSignature;
    hasApprovedPayment = mp.hasApprovedPayment;
  }
}));
vi.mock("../src/lib/turnstile", () => ({ verifyTurnstile: vi.fn(async () => null) }));
vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));
vi.mock("../src/services/email/order-confirmation-templates", () => ({
  sendMercadoPagoOrderConfirmationEmail: vi.fn(async () => {}),
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

const NOW = "2026-09-24T15:00:00.000Z";
const ORDER_REF = "22222222-2222-4222-8222-222222222222";
const KEY = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";

// ─── Supabase simulado que registra cada operación ───
type Op = { table: string; op: string; payload?: unknown; filters: unknown[][]; select?: string };
type Result = { data?: unknown; error?: unknown };
let ops: Op[];
let resolveOp: (op: Op) => Result;

function mockDb() {
  ops = [];
  vi.mocked(getSupabase).mockReturnValue({
    rpc: vi.fn(async (fn: string, args: unknown) => {
      const op: Op = { table: `rpc:${fn}`, op: "rpc", payload: args, filters: [] };
      ops.push(op);
      return resolveOp(op);
    }),
    from: vi.fn((table: string) => {
      const op: Op = { table, op: "select", filters: [] };
      ops.push(op);
      const done = () => Promise.resolve(resolveOp(op));
      const chain: any = {
        select: (columns: string) => { if (op.op === "select") op.select = columns; else op.select = columns; return chain; },
        insert: (payload: unknown) => { op.op = "insert"; op.payload = payload; return chain; },
        update: (payload: unknown) => { op.op = "update"; op.payload = payload; return chain; },
        delete: () => { op.op = "delete"; return chain; },
        eq: (...args: unknown[]) => { op.filters.push(["eq", ...args]); return chain; },
        is: (...args: unknown[]) => { op.filters.push(["is", ...args]); return chain; },
        single: done,
        maybeSingle: done,
        then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => done().then(resolve, reject)
      };
      return chain;
    })
  } as any);
}

const env = {
  MP_ACCESS_TOKEN: "TEST-token",
  MP_WEBHOOK_SECRET: "secret",
  MP_WEBHOOK_NOTIFICATION_URL: "https://api.brotalia.com.ar/api/webhooks/mercadopago",
  APP_BASE_URL: "https://brotalia.com.ar"
} as any;

async function json(response: Response) {
  const body = (await response.json()) as Record<string, unknown>;
  delete body.error_id;
  return { status: response.status, body };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  vi.spyOn(crypto, "randomUUID").mockReturnValue(ORDER_REF);
  resolveOp = () => ({ data: null, error: null });
  mockDb();
});

afterEach(() => vi.useRealTimers());

// ═════════════════════════ POST /payments/create ═════════════════════════

const quote = () => ({
  items: [{
    variant_id: "v1", product_id: "p1", sku: "SEM-048", product_name: "Semillera", quantity: 2, units_per_pack: 48,
    units_per_pack_master: 960, stock: 20, cost_usd_master: 19, cost_usd_master_original: 20, cost_currency: "USD",
    price_ars: 10000, price_usd: 6.67, price_ars_no_discount: 10500, price_ars_no_tax: 8264, image_url: null,
    subtotal_ars: 20000, subtotal_usd: 13.33, discount_percentage: 5,
    id: "v1", title: "Semillera", description: "SKU SEM-048", currency_id: "ARS", unit_price: 10000
  }],
  taxes: [], subtotalArs: 20000, subtotalUsd: 13.33, shippingArs: 13402, packagingBoxes: [], embalajeArs: 1351,
  exchangeRate: 1500, paymentCommissionPercentage: 10, subtotalNoDiscountArs: 21000
});

const paymentBody = () => ({
  turnstile_token: "tok",
  items: [{ variant_id: "v1", quantity: 2 }],
  customer: { nombre: "Ana Gómez", email: "ana@example.com", cuit: "27-12345678-3", codigoArea: "11", celular: "44445555" },
  shipping: {
    method: "delivery",
    address: { recipient_name: "Ana Gómez", postal_code: "1407", province: "Buenos Aires", locality: "Ramos Mejía", county: "La Matanza", street: "Rivadavia", street_number: "14000" }
  },
  expected_total_ars: 33402,
  idempotency_key: KEY
});

function createPayment(body: unknown) {
  return handleCreatePayment({
    request: new Request("https://api.test/payments/create", { method: "POST", body: JSON.stringify(body) }),
    env,
    params: {},
    url: new URL("https://api.test/payments/create")
  });
}

describe("POST /payments/create", () => {
  beforeEach(() => {
    vi.mocked(buildOrderQuote).mockResolvedValue(quote() as any);
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue(null);
    vi.mocked(createOrderRecord).mockResolvedValue({ id: "order-1" } as any);
    mp.createPreference.mockResolvedValue({ init_point: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1" });
  });

  const invalid: Array<[string, unknown, string]> = [
    ["sin ítems", { ...paymentBody(), items: [] }, "items must contain between 1 and 50 entries"],
    ["ítems no es lista", { ...paymentBody(), items: "x" }, "items must be an array"],
    ["mail inválido", { ...paymentBody(), customer: { ...paymentBody().customer, email: "x" } }, "customer.email is invalid"],
    ["cantidad inválida", { ...paymentBody(), items: [{ variant_id: "v1", quantity: 0 }] }, "Each item requires a valid variant_id and positive quantity"],
    ["envío incompleto", { ...paymentBody(), shipping: { method: "delivery", address: {} } }, "Delivery shipping requires street, street_number, postal_code, province, and locality outside CABA"],
    ["key inválida", { ...paymentBody(), idempotency_key: "x" }, "idempotency_key must be a valid UUID"]
  ];
  for (const [name, body, message] of invalid) {
    it(`valida: ${name}`, async () => {
      expect(await json(await createPayment(body))).toEqual({ status: 400, body: { error: message, status: 400 } });
      expect(createOrderRecord).not.toHaveBeenCalled();
    });
  }

  it("crea la orden, la preferencia (pedido exacto a Mercado Pago) y descuenta stock", async () => {
    const result = await json(await createPayment(paymentBody()));
    expect(result).toEqual({ status: 200, body: { init_point: "https://www.mercadopago.com.ar/checkout/v1/redirect?pref_id=1" } });

    expect(vi.mocked(createOrderRecord).mock.calls[0].slice(1)).toEqual([
      paymentBody().customer,
      [{ variant_id: "v1", product_id: "p1", sku: "SEM-048", product_name: "Semillera", quantity: 2, units_per_pack: 48, units_per_pack_master: 960, unit_price: 10000 }],
      20000, 1500, ORDER_REF,
      { method: "delivery", address: { recipient_name: "Ana Gómez", postal_code: "1407", province: "Buenos Aires", locality: "Ramos Mejía", county: "La Matanza", street: "Rivadavia", street_number: "14000", floor: "", apartment: "", country: "", observations: "" } },
      13402, 1351, "mercadopago", 0, 0, KEY
    ]);
    expect(mp.createPreference.mock.calls[0][0]).toMatchSnapshot();
    expect(ops).toEqual([{ table: "rpc:decrement_order_stock", op: "rpc", payload: { p_order_id: "order-1" }, filters: [] }]);
  });

  it("el total cambió: 409 price_changed, sin crear nada", async () => {
    expect(await json(await createPayment({ ...paymentBody(), expected_total_ars: 30000 }))).toEqual({
      status: 409, body: { error: "price_changed", status: 409, current_total_ars: 33402, expected_total_ars: 30000 }
    });
    expect(findOrderByIdempotencyKey).not.toHaveBeenCalled();
  });

  it("reintento con la misma key y los mismos ítems: actualiza la orden pendiente y da un link nuevo", async () => {
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue({
      id: "order-old", external_reference: "ref-old", status: "pending", order_items: [{ product_variant_id: "v1", quantity: 2 }]
    });
    resolveOp = op => (op.op === "update" ? { data: [{ id: "order-old" }], error: null } : { data: null, error: null });

    expect((await createPayment(paymentBody())).status).toBe(200);
    expect(createOrderRecord).not.toHaveBeenCalled();
    expect(ops).toEqual([{
      table: "orders", op: "update",
      payload: { subtotal_amount: 20000, shipping_amount: 13402, embalaje_amount: 1351, total_amount: 33402, payment_discount_percentage: 0, payment_discount_amount: 0, exchange_rate_used: 1500, updated_at: NOW },
      filters: [["eq", "id", "order-old"], ["eq", "status", "pending"], ["eq", "payment_status", "pending"]],
      select: "id"
    }]);
    expect(mp.createPreference.mock.calls[0][0].external_reference).toBe("ref-old");
    expect(mp.createPreference.mock.calls[0][0].metadata).toEqual({ order_id: "order-old", external_reference: "ref-old" });
  });

  it("reintento sobre una orden que ya no está pendiente: 400", async () => {
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue({
      id: "order-old", external_reference: "ref-old", status: "pending", order_items: [{ product_variant_id: "v1", quantity: 2 }]
    });
    resolveOp = () => ({ data: [], error: null });
    expect(await json(await createPayment(paymentBody()))).toEqual({ status: 400, body: { error: "This order already has a payment in progress", status: 400 } });
  });

  it("misma key con otros ítems: 409 idempotency_conflict", async () => {
    vi.mocked(findOrderByIdempotencyKey).mockResolvedValue({
      id: "order-old", external_reference: "ref-old", status: "cancelled", order_items: [{ product_variant_id: "v1", quantity: 2 }]
    });
    expect(await json(await createPayment(paymentBody()))).toEqual({ status: 409, body: { error: "idempotency_conflict", status: 409 } });
  });

  it("choque de inserción simultánea: reusa la orden del otro request", async () => {
    vi.mocked(createOrderRecord).mockRejectedValue(new DuplicateOrderError("order-dup", "ref-dup"));
    resolveOp = op => (op.op === "update" ? { data: [{ id: "order-dup" }], error: null } : { data: null, error: null });
    expect((await createPayment(paymentBody())).status).toBe(200);
    expect(mp.createPreference.mock.calls[0][0].external_reference).toBe("ref-dup");
  });

  it("no alcanza el stock: cancela la orden y responde 400", async () => {
    resolveOp = op => (op.op === "rpc" ? { error: { message: "insufficient" } } : { data: null, error: null });
    expect(await json(await createPayment(paymentBody()))).toEqual({ status: 400, body: { error: "Insufficient stock to complete the order", status: 400 } });
    expect(ops[1]).toEqual({
      table: "orders", op: "update", payload: { status: "cancelled", payment_status: "rejected", updated_at: NOW }, filters: [["eq", "id", "order-1"]]
    });
  });

  it("falla Mercado Pago al crear la preferencia: cancela la orden y responde 500", async () => {
    mp.createPreference.mockRejectedValue(new Error("MP caído"));
    expect(await json(await createPayment(paymentBody()))).toEqual({ status: 500, body: { error: "Unable to create payment", status: 500 } });
    expect(ops).toEqual([{
      table: "orders", op: "update", payload: { status: "cancelled", payment_status: "rejected", updated_at: NOW }, filters: [["eq", "id", "order-1"]]
    }]);
  });
});

// ═════════════════════════ Webhook de Mercado Pago ═════════════════════════

const mpPayment = (overrides: Record<string, unknown> = {}) => ({
  id: 555, status: "approved", status_detail: "accredited", external_reference: "ref-1",
  transaction_amount: 33402, currency_id: "ARS", date_approved: "2026-09-24T12:00:00.000-03:00", ...overrides
});

function webhook(query = "?data.id=555&type=payment", headers: Record<string, string> = { "x-request-id": "req-1", "x-signature": "ts=1,v1=abc" }) {
  const url = new URL(`https://api.test/api/webhooks/mercadopago${query}`);
  return handleMercadoPagoWebhook({ request: new Request(url, { method: "POST", headers }), env, params: {}, url });
}

describe("POST /api/webhooks/mercadopago", () => {
  beforeEach(() => {
    mp.validateWebhookSignature.mockResolvedValue(true);
    mp.getPayment.mockResolvedValue(mpPayment());
  });

  it("notificación que no es de pago: se ignora con 200", async () => {
    expect(await json(await webhook("?topic=merchant_order&id=1"))).toEqual({ status: 200, body: { success: true, ignored: true } });
    expect(mp.getPayment).not.toHaveBeenCalled();
  });

  it("sin x-request-id: 400", async () => {
    expect(await json(await webhook(undefined, { "x-signature": "x" }))).toEqual({ status: 400, body: { error: "Missing Mercado Pago webhook identifiers", status: 400 } });
  });

  it("firma inválida: 401 sin consultar el pago", async () => {
    mp.validateWebhookSignature.mockResolvedValue(false);
    expect(await json(await webhook())).toEqual({ status: 401, body: { error: "Invalid Mercado Pago webhook signature", status: 401 } });
    expect(mp.validateWebhookSignature).toHaveBeenCalledWith("ts=1,v1=abc", "req-1", "555", "secret");
    expect(mp.getPayment).not.toHaveBeenCalled();
  });

  it("pago aprobado nuevo: registra el pago, marca la orden pagada, manda mail y descuenta stock", async () => {
    resolveOp = op => {
      if (op.table === "orders" && op.op === "select") return { data: { id: "order-1", total_amount: "33402", status: "pending", payment_status: "pending" }, error: null };
      if (op.table === "orders" && op.op === "update") return { data: [{ id: "order-1" }], error: null };
      return { data: null, error: null };
    };
    expect(await json(await webhook())).toEqual({ status: 200, body: { success: true } });
    expect(mp.getPayment).toHaveBeenCalledWith("555");
    expect(ops).toEqual([
      { table: "orders", op: "select", select: "id, total_amount, status, payment_status", filters: [["eq", "external_reference", "ref-1"]] },
      { table: "payments", op: "select", select: "id, order_id, external_payment_id, status", filters: [["eq", "external_payment_id", "555"]] },
      { table: "payments", op: "insert", payload: { order_id: "order-1", external_payment_id: "555", idempotency_key: "555", amount: 33402, currency: "ARS", status: "approved", paid_at: "2026-09-24T12:00:00.000-03:00", updated_at: NOW }, filters: [] },
      { table: "orders", op: "update", payload: { payment_status: "approved", status: "paid", updated_at: NOW, paid_at: NOW }, filters: [["eq", "id", "order-1"], ["is", "paid_at", null]], select: "id" },
      { table: "rpc:decrement_order_stock", op: "rpc", payload: { p_order_id: "order-1" }, filters: [] }
    ]);
    expect(sendMercadoPagoOrderConfirmationEmail).toHaveBeenCalledWith(env, "order-1", mpPayment());
  });

  it("otra entrega del mismo webhook ya ganada por otro request: no repite mail ni stock", async () => {
    resolveOp = op => {
      if (op.table === "orders" && op.op === "select") return { data: { id: "order-1", total_amount: 33402, status: "pending", payment_status: "pending" }, error: null };
      if (op.table === "payments" && op.op === "select") return { data: { id: "pay-1", order_id: "order-1", external_payment_id: "555", status: "approved" }, error: null };
      if (op.table === "orders" && op.op === "update") return { data: [], error: null };
      return { data: null, error: null };
    };
    expect((await webhook()).status).toBe(200);
    expect(ops.map(o => `${o.table}:${o.op}`)).toEqual(["orders:select", "payments:select", "payments:update", "orders:update"]);
    expect(ops[2].payload).toEqual({ status: "approved", amount: 33402, currency: "ARS", paid_at: "2026-09-24T12:00:00.000-03:00", updated_at: NOW });
    expect(ops[2].filters).toEqual([["eq", "id", "pay-1"]]);
    expect(sendMercadoPagoOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it("orden ya pagada: no toca nada", async () => {
    resolveOp = () => ({ data: { id: "order-1", total_amount: 33402, status: "paid", payment_status: "approved" }, error: null });
    expect((await webhook()).status).toBe(200);
    expect(ops.map(o => `${o.table}:${o.op}`)).toEqual(["orders:select"]);
  });

  it("pago rechazado: la orden pasa a cancelada, sin mail ni stock", async () => {
    mp.getPayment.mockResolvedValue(mpPayment({ status: "rejected", date_approved: null }));
    resolveOp = op => {
      if (op.table === "orders" && op.op === "select") return { data: { id: "order-1", total_amount: 33402, status: "pending", payment_status: "pending" }, error: null };
      if (op.table === "payments" && op.op === "select") return { data: null, error: null };
      return { data: [], error: null };
    };
    expect((await webhook()).status).toBe(200);
    expect(ops[3]).toEqual({ table: "orders", op: "update", payload: { payment_status: "rejected", status: "cancelled", updated_at: NOW }, filters: [["eq", "id", "order-1"]], select: "id" });
    expect(sendMercadoPagoOrderConfirmationEmail).not.toHaveBeenCalled();
  });

  it("monto distinto al de la orden: 500 y no registra nada", async () => {
    mp.getPayment.mockResolvedValue(mpPayment({ transaction_amount: 100 }));
    resolveOp = () => ({ data: { id: "order-1", total_amount: 33402, status: "pending", payment_status: "pending" }, error: null });
    expect(await json(await webhook())).toEqual({ status: 500, body: { error: "Unable to process Mercado Pago webhook", status: 500 } });
    expect(ops.map(o => `${o.table}:${o.op}`)).toEqual(["orders:select"]);
  });

  it("pago vinculado a otra orden: 500", async () => {
    resolveOp = op => {
      if (op.table === "orders") return { data: { id: "order-1", total_amount: 33402, status: "pending", payment_status: "pending" }, error: null };
      return { data: { id: "pay-9", order_id: "order-9", external_payment_id: "555", status: "approved" }, error: null };
    };
    expect((await webhook()).status).toBe(500);
    expect(ops.map(o => `${o.table}:${o.op}`)).toEqual(["orders:select", "payments:select"]);
  });

  it("orden inexistente: 500", async () => {
    resolveOp = () => ({ data: null, error: { message: "no rows" } });
    expect((await webhook()).status).toBe(500);
  });
});
