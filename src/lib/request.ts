// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Lee el body JSON de un request sin lanzar si es inválido.
// POR QUÉ:  Un JSON malformado terminaba en 500 (o en el catch genérico)
//           en vez de un 400 claro para el cliente.
// ─────────────────────────────────────────────────────────────

/** Devuelve el body parseado, o null si no es JSON válido. */
export async function readJsonBody(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/**
 * Entero de un query param acotado a [min, max]. Con un valor ausente o no
 * numérico devuelve el valor por defecto (Math.max(1, NaN) da NaN y rompía el
 * offset de paginación y el descuento por volumen).
 */
export function parseIntParam(value: string | null, fallback: number, min: number, max = Number.MAX_SAFE_INTEGER): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
