import { jsonResponse, errorResponse } from "./response";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Tipado y contratos para el router modular
// POR QUÉ:  Garantiza consistencia y facilita la expansión (Problema B1)
// CUIDADO:  Diseñado para ser stateless y compatible con Cloudflare Workers
// ─────────────────────────────────────────────────────────────

/** Contexto compartido para todos los handlers */
export interface RouteContext {
  request: Request;
  env: any;
  params: Record<string, string>;
  url: URL;
}

/** Firma de un handler de ruta */
export type RouteHandler = (ctx: RouteContext) => Promise<Response>;

/** Definición de una ruta */
export interface Route {
  method: "GET" | "POST" | "PUT" | "DELETE" | "OPTIONS";
  path: string; // Puede contener :params
  handler: RouteHandler;
}

/**
 * Router minimalista para Cloudflare Workers
 */
export class Router {
  private routes: Route[] = [];

  get(path: string, handler: RouteHandler) {
    this.routes.push({ method: "GET", path, handler });
  }

  post(path: string, handler: RouteHandler) {
    this.routes.push({ method: "POST", path, handler });
  }

  async handle(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    for (const route of this.routes) {
      if (route.method !== method) continue;

      const params = this.match(route.path, path);
      if (params) {
        try {
          return await route.handler({ request, env, params, url });
        } catch (e: any) {
          console.error(`Router error [${method} ${path}]:`, e);
          const message = e instanceof Error ? e.message : String(e);
          const stack = e instanceof Error ? e.stack : undefined;
          return errorResponse(`Handler Error: ${message}`, 500, { stack });
        }
      }
    }

    return new Response("Not Found", { status: 404 });
  }

  /**
   * Match de ruta simple con soporte para :params
   * Retorna objeto de params si matchea, null si no.
   */
  private match(routePath: string, actualPath: string): Record<string, string> | null {
    // Normalizamos para ignorar slashes al final y que funcionen rutas como /products/
    const routeParts = routePath.split("/").filter(Boolean);
    const actualParts = actualPath.split("/").filter(Boolean);

    if (routeParts.length !== actualParts.length) return null;

    const params: Record<string, string> = {};

    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(":")) {
        const paramName = routeParts[i].substring(1);
        params[paramName] = actualParts[i];
      } else if (routeParts[i] !== actualParts[i]) {
        return null;
      }
    }

    return params;
  }
}
