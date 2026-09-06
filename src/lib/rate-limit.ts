import { errorResponse } from "./response";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Aplica rate limiting a rutas sensibles usando el binding
//           nativo de Cloudflare Workers (env.RATE_LIMITER).
// POR QUÉ:  /orders, /payments/create y /shipping/quote no tenían
//           ningún límite de requests, habilitando abuso/DoS de bajo
//           costo y scraping de precios/stock.
// CUIDADO:  Si el binding no está configurado (p.ej. entorno de test
//           sin bindings de Cloudflare), se falla "abierto" para no
//           romper flujos existentes.
// ─────────────────────────────────────────────────────────────

/**
 * Aplica el límite de requests para una ruta dada, particionado por IP.
 * Devuelve una Response 429 si se excedió el límite, o null si puede continuar.
 */
export async function enforceRateLimit(env: any, request: Request, routeKey: string): Promise<Response | null> {
  const limiter = env?.RATE_LIMITER;
  if (!limiter || typeof limiter.limit !== "function") return null;

  const ip = request.headers.get("CF-Connecting-IP") || request.headers.get("X-Forwarded-For") || "unknown";

  try {
    const { success } = await limiter.limit({ key: `${routeKey}:${ip}` });
    if (!success) return errorResponse("Too many requests", 429);
  } catch {
    // Si el binding falla de forma inesperada, no bloqueamos el flujo de compra.
    return null;
  }

  return null;
}
