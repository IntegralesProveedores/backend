import { Router } from "./lib/router";
import { errorResponse } from "./lib/response";
import { handleProducts, handleProductBySlug } from "./routes/products";
import { handleCreateOrder, handleGetOrder } from "./routes/orders";
import { handleSitemap } from "./routes/sitemap";
import {
  handleCategories,
  handleCategoryBySlug,
  handleCategoryProducts
} from "./routes/categories";
import { handleSettings } from "./routes/settings";
import { handlePaymentTransferInfo } from "./routes/payment-transfer-info";
import { handleMercadoPagoWebhook } from "./routes/webhooks";
import { handleCreatePayment } from "./routes/payments";
import { handlePostalCode } from "./routes/postal-code";
import { handleShippingQuote } from "./routes/shipping";
import { releaseAbandonedOrders } from "./services/stock-release.service";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

const ALLOWED_ORIGINS = [
  "https://brotalia.com.ar",
  "https://www.brotalia.com.ar",
  "http://localhost:4200"
];

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  const origin = request.headers.get("Origin");
  if (origin && ALLOWED_ORIGINS.includes(origin)) {
    headers.set("Access-Control-Allow-Origin", origin);
  } else {
    headers.delete("Access-Control-Allow-Origin");
  }
  // Access-Control-Allow-Origin varía según el Origin del request: sin este
  // header, un cache (CDN/browser) podría servirle a un origen la respuesta
  // cacheada para otro origen distinto.
  headers.set("Vary", "Origin");
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

function sanitizeEnv(env: any): any {
  return Object.keys(env).reduce((acc: any, key) => {
    acc[key] = typeof env[key] === "string" ? env[key].trim() : env[key];
    return acc;
  }, {});
}

const router = new Router();

router.get("/products", handleProducts);
router.get("/products/:slug", handleProductBySlug);
router.get("/categories", handleCategories);
router.get("/categories/:slug", handleCategoryBySlug);
router.get("/categories/:slug/products", handleCategoryProducts);
router.get("/settings", handleSettings);
router.get("/payment-transfer-info", handlePaymentTransferInfo);
router.get("/postal-code/:postalCode", handlePostalCode);
router.post("/shipping/quote", handleShippingQuote);
router.get("/sitemap.xml", handleSitemap);
router.post("/orders", handleCreateOrder);
router.get("/orders/:id", handleGetOrder);
router.post("/payments/create", handleCreatePayment);
router.post("/api/webhooks/mercadopago", handleMercadoPagoWebhook);

export default {
  async fetch(request: Request, env: any) {
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204, headers: CORS_HEADERS }));
    }

    const hostHeader = (request.headers.get("host") || "").toLowerCase();

    const sanitizedEnv = sanitizeEnv(env);

    try {
      const response = await router.handle(request, sanitizedEnv);
      return withCors(request, response);
    } catch (e: any) {
      return withCors(request,
        errorResponse("Internal server error", 500, {
          original_message: e.message,
          stack: e.stack,
          host: hostHeader
        })
      );
    }
  },

  // Cron (wrangler.jsonc > triggers): cancela órdenes pendientes abandonadas y devuelve su stock.
  async scheduled(_controller: ScheduledController, env: any, ctx: ExecutionContext) {
    ctx.waitUntil(
      releaseAbandonedOrders(sanitizeEnv(env)).catch(error => {
        console.error(JSON.stringify({ event: "stock_release_run_failed", message: String(error) }));
      })
    );
  }
};
