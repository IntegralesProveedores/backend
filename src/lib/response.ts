// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Helper centralizado para respuestas JSON con CORS y Logs
// POR QUÉ:  Evita duplicación en cada route (Problema B2) y garantiza observabilidad (B10)
// CUIDADO:  No agrega headers de CORS aquí, se manejan en index.ts con withCors
// ─────────────────────────────────────────────────────────────

export function jsonResponse(data: any, status = 200, cacheSeconds = 0) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-cache"
    }
  });
}

/**
 * Retorna una respuesta de error estandarizada y loguea el evento de forma estructurada.
 */
export function errorResponse(message: string, status = 500, details?: any) {
  const errorId = crypto.randomUUID();
  
  // Log estructurado (B10)
  console.error(JSON.stringify({
    error_id: errorId,
    timestamp: new Date().toISOString(),
    status,
    message,
    details
  }));

  return jsonResponse({ 
    error: message, 
    error_id: errorId,
    status 
  }, status, 0);
}
