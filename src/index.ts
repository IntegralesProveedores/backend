import { Router } from "./lib/router";
import { errorResponse } from "./lib/response";
import { 
  handleProducts, 
  handleProductBySlug 
} from "./routes/products";
import {
  handleCategories,
  handleCategoryBySlug,
  handleCategoryProducts
} from "./routes/categories";
import { handleSettings } from "./routes/settings";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Punto de entrada principal y Router (B1)
// POR QUÉ:  Estructura modular y escalable para el Worker
// CUIDADO:  Manejo global de CORS y errores
// ─────────────────────────────────────────────────────────────

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

/**
 * Agrega headers de CORS a cualquier Response
 */
function withCors(response: Response): Response {
  const newHeaders = new Headers(response.headers);
  Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
  return new Response(response.body, {
    status: response.status,
    headers: newHeaders,
  });
}

// Inicialización del Router
const router = new Router();

// Catálogo
router.get("/products", handleProducts);
router.get("/products/:slug", handleProductBySlug);

// Categorías
router.get("/categories", handleCategories);
router.get("/categories/:slug", handleCategoryBySlug);
router.get("/categories/:slug/products", handleCategoryProducts);

// Configuración
router.get("/settings", handleSettings);

export default {
  async fetch(request: Request, env: any) {
    // 1. Manejo global de OPTIONS (Preflight)
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ─────────────────────────────────────────────────────────────
    // QUÉ HACE: Normaliza la URL del request basándose en el header Host o X-Tenant-Host
    // POR QUÉ:  En desarrollo local (Wrangler), el header Host puede ser sanitizado. 
    //           X-Tenant-Host permite forzar un dominio para testear multi-tenancy.
    // CUIDADO:  Solo aplica si el host detectado contiene palabras clave conocidas.
    // ─────────────────────────────────────────────────────────────
    const hostHeader = (request.headers.get("x-tenant-host") || request.headers.get("host") || "").toLowerCase();
    
    if (hostHeader && (hostHeader.includes("brotalia") || hostHeader.includes("integrales"))) {
      const url = new URL(request.url);
      // Solo actualizamos el host si es un dominio de negocio, no 127.0.0.1
      if (!hostHeader.includes("127.0.0.1") && !hostHeader.includes("localhost")) {
        url.host = hostHeader;
        request = new Request(url.toString(), request);
      }
    }

    // ─────────────────────────────────────────────────────────────
    // QUÉ HACE: Sanitiza las variables de entorno para evitar caracteres invisibles
    // POR QUÉ:  Evita errores 401/400 por newlines o espacios en los secretos (B7)
    // ─────────────────────────────────────────────────────────────
    const sanitizedEnv = Object.keys(env).reduce((acc: any, key) => {
      acc[key] = typeof env[key] === "string" ? env[key].trim() : env[key];
      return acc;
    }, {});

    // 2. Ejecutar Router con Manejo Global de Errores
    try {
      const response = await router.handle(request, sanitizedEnv);
      return withCors(response);
    } catch (e: any) {
      return withCors(errorResponse(`Worker Error: ${e.message}`, 500, {
        stack: e.stack,
        host: hostHeader
      }));
    }
  }
};
