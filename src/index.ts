import { Router } from "./lib/router";
import { errorResponse } from "./lib/response";
import { handleProducts, handleProductBySlug } from "./routes/products";
import { handleCreateOrder } from "./routes/orders";
import { handleSitemap } from "./routes/sitemap";
import {
  handleCategories,
  handleCategoryBySlug,
  handleCategoryProducts
} from "./routes/categories";
import { handleSettings } from "./routes/settings";

const CORS_HEADERS = {
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};

function withCors(request: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => headers.set(key, value));
  const origin = request.headers.get("Origin");
  if (origin === "https://brotalia.com.ar" || origin === "http://localhost:4200") {
    headers.set("Access-Control-Allow-Origin", origin);
  } else {
    headers.delete("Access-Control-Allow-Origin");
  }
  return new Response(response.body, {
    status: response.status,
    headers
  });
}

const router = new Router();

router.get("/products", handleProducts);
router.get("/products/:slug", handleProductBySlug);
router.get("/categories", handleCategories);
router.get("/categories/:slug", handleCategoryBySlug);
router.get("/categories/:slug/products", handleCategoryProducts);
router.get("/settings", handleSettings);
router.get("/sitemap.xml", handleSitemap);
router.post("/orders", handleCreateOrder);

export default {
  async fetch(request: Request, env: any) {
    if (request.method === "OPTIONS") {
      return withCors(request, new Response(null, { status: 204, headers: CORS_HEADERS }));
    }

    const hostHeader = (request.headers.get("host") || "").toLowerCase();

    const sanitizedEnv = Object.keys(env).reduce((acc: any, key) => {
      acc[key] = typeof env[key] === "string" ? env[key].trim() : env[key];
      return acc;
    }, {});

    try {
      const response = await router.handle(request, sanitizedEnv);
      return withCors(request, response);
    } catch (e: any) {
      return withCors(request,
        errorResponse(`Worker Error: ${e.message}`, 500, {
          stack: e.stack,
          host: hostHeader
        })
      );
    }
  }
};
