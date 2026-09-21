import { errorResponse } from "./response";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Verifica el token de Cloudflare Turnstile que envía el checkout.
// POR QUÉ:  /orders y /payments/create eran abusables: cualquiera podía
//           disparar mails a terceros y agotar el tope diario de Resend.
// CUIDADO:  Falla "cerrado": sin TURNSTILE_SECRET_KEY o si Cloudflare no
//           responde, se rechaza el pedido (el rate limit de rate-limit.ts
//           falla abierto, este no).
// ─────────────────────────────────────────────────────────────

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const MAX_TOKEN_LENGTH = 2048;

/**
 * Devuelve una Response de error si el token no es válido, o null si puede continuar.
 */
export async function verifyTurnstile(env: any, request: Request, token: unknown): Promise<Response | null> {
  const secret = typeof env?.TURNSTILE_SECRET_KEY === "string" ? env.TURNSTILE_SECRET_KEY : "";
  if (!secret) {
    return errorResponse("Captcha verification is not configured", 503);
  }

  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_LENGTH) {
    return errorResponse("Captcha token is required", 400);
  }

  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  const ip = request.headers.get("CF-Connecting-IP");
  if (ip) form.append("remoteip", ip);

  try {
    const response = await fetch(SITEVERIFY_URL, { method: "POST", body: form });
    const result = await response.json() as { success?: boolean; "error-codes"?: string[] };
    if (!result.success) {
      return errorResponse("Captcha verification failed", 400, { codes: result["error-codes"] });
    }
    return null;
  } catch (error) {
    return errorResponse("Captcha verification unavailable", 503, {
      original_message: error instanceof Error ? error.message : String(error)
    });
  }
}
