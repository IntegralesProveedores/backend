import { describe, expect, it } from "vitest";
import { applyCatalogFallback, isCatalogRequest } from "../src/lib/catalog-fallback";

function fakeKv() {
  const data = new Map<string, { value: string; metadata: unknown }>();
  return {
    data,
    getWithMetadata: async (key: string) => ({ value: data.get(key)?.value ?? null, metadata: data.get(key)?.metadata ?? null }),
    get: async (key: string) => data.get(key)?.value ?? null,
    put: async (key: string, value: string, options?: { metadata?: unknown }) => {
      data.set(key, { value, metadata: options?.metadata });
    }
  };
}

function fakeCtx() {
  const pending: Promise<unknown>[] = [];
  return { ctx: { waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as ExecutionContext, done: () => Promise.all(pending) };
}

const get = (path: string) => new Request(`https://api.test${path}`);
const ok = (body: string) => new Response(body, { status: 200 });

describe("respaldo del catálogo", () => {
  it("solo aplica a GET /products* y /categories*", () => {
    expect(isCatalogRequest("GET", "/products")).toBe(true);
    expect(isCatalogRequest("GET", "/products/olivo")).toBe(true);
    expect(isCatalogRequest("GET", "/categories/x/products")).toBe(true);
    expect(isCatalogRequest("POST", "/orders")).toBe(false);
    expect(isCatalogRequest("GET", "/settings")).toBe(false);
    expect(isCatalogRequest("GET", "/productsx")).toBe(false);
  });

  it("guarda la respuesta buena y la sirve si después falla con 500", async () => {
    const kv = fakeKv();
    const env = { PRICING_CACHE: kv };
    const { ctx, done } = fakeCtx();

    await applyCatalogFallback(get("/products?page=1"), env, ctx, ok('{"items":[1]}'));
    await done();
    expect(kv.data.size).toBe(1);

    const failed = await applyCatalogFallback(get("/products?page=1"), env, fakeCtx().ctx, new Response("x", { status: 500 }));
    expect(failed.status).toBe(200);
    expect(failed.headers.get("X-Served-From")).toBe("stale-fallback");
    expect(await failed.text()).toBe('{"items":[1]}');
  });

  it("no vuelve a escribir si la copia es reciente", async () => {
    const kv = fakeKv();
    const env = { PRICING_CACHE: kv };
    const first = fakeCtx();
    await applyCatalogFallback(get("/products"), env, first.ctx, ok("v1"));
    await first.done();
    const second = fakeCtx();
    await applyCatalogFallback(get("/products"), env, second.ctx, ok("v2"));
    await second.done();
    expect([...kv.data.values()][0].value).toBe("v1");
  });

  it("sin copia devuelve el 500 original; los 4xx nunca se reemplazan", async () => {
    const env = { PRICING_CACHE: fakeKv() };
    const failed = await applyCatalogFallback(get("/products"), env, fakeCtx().ctx, new Response("x", { status: 500 }));
    expect(failed.status).toBe(500);

    const kv = fakeKv();
    kv.data.set("catalog_fallback:/products/x", { value: "old", metadata: null });
    const notFound = await applyCatalogFallback(get("/products/x"), { PRICING_CACHE: kv }, fakeCtx().ctx, new Response("nf", { status: 404 }));
    expect(notFound.status).toBe(404);
  });

  it("no toca las rutas de compra ni funciona sin KV", async () => {
    const post = new Request("https://api.test/orders", { method: "POST" });
    const failed = await applyCatalogFallback(post, { PRICING_CACHE: fakeKv() }, fakeCtx().ctx, new Response("x", { status: 500 }));
    expect(failed.status).toBe(500);

    const noKv = await applyCatalogFallback(get("/products"), {}, fakeCtx().ctx, new Response("x", { status: 500 }));
    expect(noKv.status).toBe(500);
  });
});
