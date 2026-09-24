import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendMercadoPagoOrderConfirmationEmail,
  sendTransferOrderConfirmationEmail
} from "../src/services/email/order-confirmation-templates";
import { getSupabase } from "../src/services/db";
import { resolvePackagingPlan, resolveShippingRate } from "../src/services/shipping.service";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Test de caracterización de los dos mails de confirmación (transferencia y
//           Mercado Pago aprobado): guarda en un snapshot el request EXACTO que se manda a
//           Resend (destinatarios, asunto, HTML y texto) y qué se consulta en la base.
// POR QUÉ:  Red de seguridad para separar plantillas, consultas y cliente de Resend sin
//           cambiar una sola línea del mail. Si el HTML cambia, el snapshot falla.
// CUIDADO:  La fecha está fija (la entrega estimada depende del día). Para aceptar un cambio
//           INTENCIONAL del mail: `npx vitest run -u` y revisar el diff del snapshot.
// ─────────────────────────────────────────────────────────────

vi.mock("../src/services/db", () => ({ getSupabase: vi.fn() }));
vi.mock("../src/services/settings", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/services/settings")>()),
  getCachedTaxes: vi.fn(async () => [{ name: "IVA", percentage: 21, is_computable: true, is_active: true }])
}));
vi.mock("../src/services/shipping.service", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/services/shipping.service")>()),
  resolvePackagingPlan: vi.fn(),
  resolveShippingRate: vi.fn()
}));

const env = { APP_BASE_URL: "https://brotalia.com.ar/", RESEND_API_KEY: "re_test_key" } as unknown as Env;

const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));

function sentEmail() {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, method: init.method, headers: init.headers, body: JSON.parse(String(init.body)) };
}

/** Supabase simulado: cada tabla devuelve lo que se le pase, sin importar la forma del query. */
function mockTables(tables: Record<string, { data: unknown; error: unknown }>) {
  const calls: Array<{ table: string; select?: string; eq: unknown[][] }> = [];
  vi.mocked(getSupabase).mockReturnValue({
    from: vi.fn((table: string) => {
      const call = { table, eq: [] as unknown[][] } as { table: string; select?: string; eq: unknown[][] };
      calls.push(call);
      const result = tables[table] ?? { data: null, error: null };
      const chain: any = {
        select: (columns: string) => { call.select = columns.replace(/\s+/g, " ").trim(); return chain; },
        eq: (...args: unknown[]) => { call.eq.push(args); return chain; },
        order: () => chain,
        single: async () => result,
        maybeSingle: async () => result,
        then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
          Promise.resolve(result).then(resolve, reject)
      };
      return chain;
    })
  } as any);
  return calls;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-24T12:00:00-03:00")); // jueves
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const transferAccount = {
  bank_name: "Mercado Pago", alias: "brotalia.mp", cvu: "0000003100000000000001", cbu: null,
  account_number: null, account_holder_name: "Brotalia <SRL>", account_holder_tax_id: "30-12345678-9"
};

const transferInput = () => ({
  orderRef: "11111111-1111-4111-8111-111111111111",
  customer: { nombre: "Juan <b>Pérez</b>", email: "juan@example.com", cuit: "20-12345678-9", codigoArea: "11", celular: "12345678" },
  items: [
    { product_name: "Semillera", sku: "SEM-048", quantity: 2, units_per_pack: 48, subtotal_ars: 20000, price_ars_no_discount: 10500, price_ars_no_tax: 8264, image_url: "/assets/images/semillera.webp" },
    { product_name: "Semillera", sku: "SEM-096", quantity: 1, units_per_pack: 96, subtotal_ars: 19000, price_ars_no_discount: 20000, price_ars_no_tax: 15702, image_url: "/assets/images/semillera.webp" },
    { product_name: "Olivo", sku: "OLI-025", quantity: 3, units_per_pack: 25, subtotal_ars: 27000, price_ars_no_discount: 9500, price_ars_no_tax: 7851, image_url: null }
  ],
  shippingAmountArs: 0,
  packagingBoxes: [{ boxModelId: "b1", boxModelName: "Caja Chica", widthCm: 40, lengthCm: 30, heightCm: 20, weightKg: 1, count: 2 }] as any,
  totalArs: 59400,
  volumeDiscountPercentage: 5,
  vatLabel: "IVA Incluido",
  transferDiscount: { percentage: 10, amountArs: 6600 }
});

describe("mail de transferencia", () => {
  it("retiro: consulta la cuenta de Mercado Pago y manda el mail exacto", async () => {
    const calls = mockTables({ payment_transfer_info: { data: [transferAccount], error: null } });
    await sendTransferOrderConfirmationEmail(env, { ...transferInput(), shipping: { method: "pickup" } });

    expect(calls).toEqual([{
      table: "payment_transfer_info",
      select: "bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position",
      eq: [["active", true], ["bank_name", "Mercado Pago"]]
    }]);
    expect(sentEmail()).toMatchSnapshot();
  });

  it("envío a domicilio con dirección completa", async () => {
    mockTables({ payment_transfer_info: { data: [transferAccount], error: null } });
    await sendTransferOrderConfirmationEmail(env, {
      ...transferInput(),
      shippingAmountArs: 13402,
      totalArs: 71462,
      shipping: {
        method: "delivery",
        address: {
          recipient_name: "Juan Pérez", postal_code: "1407", province: "Buenos Aires", locality: "Ramos Mejía",
          county: "La Matanza", street: "Av. Rivadavia", street_number: "14000", floor: "3", apartment: "B",
          country: "AR", observations: "Timbre roto"
        }
      }
    });
    expect(sentEmail()).toMatchSnapshot();
  });

  it("coordinar, sin cuentas cargadas y sin CUIT", async () => {
    mockTables({ payment_transfer_info: { data: null, error: { message: "boom" } } });
    await sendTransferOrderConfirmationEmail(env, {
      ...transferInput(),
      customer: { ...transferInput().customer, cuit: "" },
      volumeDiscountPercentage: 0,
      shipping: { method: "coordinar" }
    });
    expect(sentEmail()).toMatchSnapshot();
  });

  it("si Resend falla no tira error (el pedido ya está creado)", async () => {
    mockTables({ payment_transfer_info: { data: [transferAccount], error: null } });
    fetchMock.mockImplementation(async () => new Response("rate limited", { status: 429 }));
    await expect(
      sendTransferOrderConfirmationEmail(env, { ...transferInput(), shipping: { method: "pickup" } })
    ).resolves.toBeUndefined();
  });
});

const payment = { id: 987654321, status: "approved", date_approved: "2026-09-24T12:30:00.000-03:00" } as any;

const orderItems = [
  { product_variant_id: "v1", quantity: 2, unit_price: 10000, product_variants: { sku: "SEM-048", units_per_pack: 48, products: { id: "p1", name: "Semillera", product_images: [{ image_url: "/b.webp", position: 2 }, { image_url: "/a.webp", position: 1 }] } } },
  { product_variant_id: "v2", quantity: 1, unit_price: 19000, product_variants: [{ sku: "SEM-096", units_per_pack: 96, products: [{ id: "p1", name: "Semillera", product_images: [] }] }] }
];

const customerRow = { full_name: "María López", email: "maria@example.com", tax_id: null, phone_area_code: "351", phone_number: "5551234" };
const addressRow = {
  recipient_name: "María López", postal_code: "5000", province: "Córdoba", locality: "Córdoba", county: "Capital",
  street: "San Martín", street_number: "100", floor: "", apartment: "", shipping_method: "delivery"
};

describe("mail de Mercado Pago aprobado", () => {
  it("orden nueva (embalaje por caja): reconstruye las cajas y manda el mail exacto", async () => {
    const calls = mockTables({
      orders: { data: { id: "order-1", total_amount: 52402, subtotal_amount: 39000, shipping_amount: 13402, embalaje_amount: 1351, payment_commission_percentage: 0, payment_commission_amount: 0 }, error: null },
      order_items: { data: orderItems, error: null },
      order_customers: { data: customerRow, error: null },
      order_addresses: { data: addressRow, error: null }
    });
    vi.mocked(resolvePackagingPlan).mockResolvedValue({
      boxes: [{ boxModelId: "b2", boxModelName: "Caja Grande", widthCm: 60, lengthCm: 40, heightCm: 40, weightKg: 3, count: 1 }]
    } as any);

    await sendMercadoPagoOrderConfirmationEmail(env, "order-1", payment);

    expect(calls.map(c => [c.table, c.eq])).toEqual([
      ["orders", [["id", "order-1"]]],
      ["order_items", [["order_id", "order-1"]]],
      ["order_customers", [["order_id", "order-1"]]],
      ["order_addresses", [["order_id", "order-1"]]]
    ]);
    expect(resolvePackagingPlan).toHaveBeenCalledWith(env, [{ product_id: "p1", units: 192 }]);
    expect(resolveShippingRate).not.toHaveBeenCalled();
    expect(sentEmail()).toMatchSnapshot();
  });

  it("orden vieja (sin embalaje por caja) con comisión: cajas del envío y línea de comisión", async () => {
    mockTables({
      orders: { data: { id: "order-2", total_amount: 57642, subtotal_amount: 39000, shipping_amount: 13402, embalaje_amount: 0, payment_commission_percentage: 10, payment_commission_amount: 5240 }, error: null },
      order_items: { data: orderItems, error: null },
      order_customers: { data: customerRow, error: null },
      order_addresses: { data: addressRow, error: null }
    });
    vi.mocked(resolveShippingRate).mockResolvedValue({
      boxes: [{ boxModelId: "b1", boxModelName: "Caja Chica", widthCm: 40, lengthCm: 30, heightCm: 20, weightKg: 1, count: 1 }]
    } as any);

    await sendMercadoPagoOrderConfirmationEmail(env, "order-2", payment);

    expect(resolveShippingRate).toHaveBeenCalledWith(env, "5000", [{ product_id: "p1", units: 192 }], "Córdoba");
    expect(sentEmail()).toMatchSnapshot();
  });

  it("si falta la dirección, igual manda el mail (sin envío)", async () => {
    mockTables({
      orders: { data: { id: "order-3", total_amount: 39000, subtotal_amount: 39000, shipping_amount: 0, embalaje_amount: 0, payment_commission_percentage: 0, payment_commission_amount: 0 }, error: null },
      order_items: { data: orderItems, error: null },
      order_customers: { data: customerRow, error: null },
      order_addresses: { data: null, error: { message: "boom" } }
    });
    await sendMercadoPagoOrderConfirmationEmail(env, "order-3", payment);
    expect(sentEmail()).toMatchSnapshot();
  });

  it("si no encuentra la orden no manda nada ni tira error", async () => {
    mockTables({ orders: { data: null, error: { message: "no rows" } } });
    await expect(sendMercadoPagoOrderConfirmationEmail(env, "order-x", payment)).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
