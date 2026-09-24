import { logEvent } from "./log";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Copia de respaldo del catálogo (GET /products*, /categories*) en KV.
//           Si Supabase falla (respuesta 5xx), se sirve la última respuesta buena.
// POR QUÉ:  Sin base de datos el sitio no mostraba nada.
// CUIDADO:  Es solo lectura. Cobrar nunca usa esto: POST /orders y /payments/create
//           recalculan todo contra la base y fallan si no responde. La copia se
//           renueva como máximo cada REFRESH_AFTER_MS por URL para cuidar las
//           escrituras de KV.
// ─────────────────────────────────────────────────────────────

const KEY_PREFIX = "catalog_fallback:";
const MAX_KEY_LENGTH = 400;
const RETENTION_SECONDS = 7 * 24 * 60 * 60;
const REFRESH_AFTER_MS = 6 * 60 * 60 * 1000;

export function isCatalogRequest(method: string, pathname: string): boolean {
  return method === "GET" && /^\/(products|categories)(\/|$)/.test(pathname);
}

function cacheKey(url: URL): string | null {
  const key = `${KEY_PREFIX}${url.pathname}${url.search}`;
  return key.length <= MAX_KEY_LENGTH ? key : null;
}

/** Guarda la respuesta buena si no hay copia o ya es vieja. Nunca rompe el request. */
export async function storeCatalogCopy(env: any, url: URL, body: string): Promise<void> {
  const kv = env?.PRICING_CACHE;
  const key = cacheKey(url);
  if (!kv || !key) return;
  try {
    const { metadata } = await kv.getWithMetadata(key);
    const savedAt = Number((metadata as { savedAt?: number } | null)?.savedAt ?? 0);
    if (Date.now() - savedAt < REFRESH_AFTER_MS) return;
    await kv.put(key, body, { expirationTtl: RETENTION_SECONDS, metadata: { savedAt: Date.now() } });
  } catch (error) {
    logEvent("warn", "catalog_fallback_store_failed", { key, message: String(error) });
  }
}

export async function loadCatalogCopy(env: any, url: URL): Promise<string | null> {
  const kv = env?.PRICING_CACHE;
  const key = cacheKey(url);
  if (!kv || !key) return null;
  try {
    return await kv.get(key);
  } catch (error) {
    logEvent("warn", "catalog_fallback_load_failed", { key, message: String(error) });
    return null;
  }
}

/** Devuelve la copia como respuesta 200 si el catálogo falló (status >= 500); si no, la respuesta original. */
export async function applyCatalogFallback(
  request: Request,
  env: any,
  ctx: ExecutionContext,
  response: Response
): Promise<Response> {
  const url = new URL(request.url);
  if (!isCatalogRequest(request.method, url.pathname)) return response;

  if (response.status === 200) {
    ctx.waitUntil(response.clone().text().then(body => storeCatalogCopy(env, url, body)));
    return response;
  }

  if (response.status < 500) return response;

  const copy = await loadCatalogCopy(env, url);
  if (!copy) return response;

  logEvent("error", "catalog_served_from_fallback", { path: url.pathname, original_status: response.status });
  return new Response(copy, {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "X-Served-From": "stale-fallback"
    }
  });
}
