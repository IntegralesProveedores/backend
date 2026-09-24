// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Envío de mails por la API de Resend (único punto que conoce Resend).
// POR QUÉ:  Antes estaba dentro del archivo de plantillas, mezclado con el HTML y las
//           consultas a la base.
// CUIDADO:  Tira si Resend responde con error: quien llama decide si eso corta el flujo
//           (los mails de confirmación lo registran y siguen: el pedido ya está creado).
// ─────────────────────────────────────────────────────────────

/** Único lugar donde configurar el remitente de los mails. */
const EMAIL_FROM = "\"Brotalia\" <ventas@brotalia.com.ar>";

/** Copia de cada mail para el negocio. Es la cuenta de Gmail a propósito (decisión del
 *  dueño, 2026-09-24): no es un resto de la marca vieja, no cambiarla a @brotalia.com.ar. */
const EMAIL_CC = ["integralesproveedores@gmail.com"];

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(env: Env, message: EmailMessage): Promise<void> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: EMAIL_FROM,
      to: [message.to],
      cc: EMAIL_CC,
      subject: message.subject,
      html: message.html,
      text: message.text
    })
  });

  if (!response.ok) {
    throw new Error(`Resend request failed with status ${response.status}: ${await response.text()}`);
  }
}
