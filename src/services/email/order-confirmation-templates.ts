import { getSupabase } from "../db";
import { PaymentCustomerInput } from "../../lib/payment-input.validation";
import { MercadoPagoPaymentResponse } from "../../lib/mercadopago.types";
import { ShippingBox, resolveShippingRate } from "../shipping.service";
import { ShippingInput } from "../../lib/payment-input.validation";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Los dos generadores de mail de confirmación de orden
//           (transferencia y Mercado Pago) y los helpers de HTML/texto
//           que comparten.
// POR QUÉ:  Antes vivían mezclados dentro de payment.service.ts junto
//           con persistencia de órdenes, envío y checkout de MP.
// ─────────────────────────────────────────────────────────────

export interface TransferOrderEmailItem {
  product_name: string;
  sku: string;
  quantity: number;
  units_per_pack: number;
  subtotal_ars: number;
  price_ars_no_discount: number;
}

export interface TransferOrderEmailInput {
  orderRef: string;
  customer: PaymentCustomerInput;
  items: TransferOrderEmailItem[];
  shipping: ShippingInput;
  shippingAmountArs: number;
  shippingBoxes: ShippingBox[];
  totalArs: number;
  volumeDiscountPercentage: number;
  vatLabel: string;
  paymentCommissionPercentage: number;
}

interface OrderConfirmationOrderRow {
  id: string;
  total_amount: number | string;
  subtotal_amount: number | string;
  shipping_amount: number | string;
  exchange_rate_used: number | string;
}

interface OrderConfirmationProductRow {
  id: string;
  name: string;
}

interface OrderConfirmationVariantRow {
  sku: string;
  units_per_pack: number | null;
  products: OrderConfirmationProductRow | OrderConfirmationProductRow[] | null;
}

interface OrderConfirmationItemRow {
  product_variant_id: string;
  quantity: number | string;
  unit_price: number | string;
  product_variants: OrderConfirmationVariantRow | OrderConfirmationVariantRow[] | null;
}

interface OrderConfirmationCustomerRow {
  full_name: string;
  email: string;
  tax_id: string | null;
  phone_area_code: string | null;
  phone_number: string | null;
}

/** Fila de order_addresses usada para armar la sección "Envío" del mail de confirmación */
interface OrderConfirmationAddressRow {
  shipping_method: "pickup" | "delivery" | "coordinar" | null;
  recipient_name: string | null;
  postal_code: string | null;
  province: string | null;
  locality: string | null;
  county: string | null;
  street: string | null;
  street_number: string | null;
  floor: string | null;
  apartment: string | null;
}

const escapeHtmlForEmail = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

const formatArsAmount = (value: number | string): string =>
  Number(value || 0).toLocaleString("es-AR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Paleta y jerarquía tomadas de app-order-summary (frontend), la misma
 * referencia visual del checkout: título de bloque en --color-text-primary,
 * labels en --color-text-muted, valores en --color-text-secondary, monto
 * destacado en --color-primary (naranja). Ver frontend/src/styles/tokens.css
 * y frontend/src/app/shared/components/order-summary/*.
 *
 * Los mails arman todo con tablas + estilos inline (nada de flexbox/grid/
 * variables CSS/clases externas) porque Outlook y otros clientes de correo
 * no las soportan de forma confiable.
 */
const EMAIL_COLORS = {
  title: "#2b3033",
  label: "#7a8178",
  value: "#5c6468",
  accent: "#e07b39",
  cardBg: "#ffffff",
  pageBg: "#fff4dc",
  wrapperBg: "#f4f4f4"
};

/** Único lugar donde configurar el remitente de los mails de confirmación. */
const EMAIL_FROM = "\"Brotalia\" <ventas@brotalia.com.ar>";

/**
 * Fuente para títulos de bloque y montos finales, sin depender de webfonts
 * (los clientes de correo no las cargan de forma confiable).
 */
const EMAIL_FONT_IMPACT = "Impact,'Arial Narrow Bold','Arial Black',sans-serif";

/**
 * https://wa.me/5491130226565 es el link de WhatsApp del negocio ya usado en
 * el sitio (footer, contacto): 54 (país) + 9 (celular AR) + 11 (área) +
 * 30226565 (número), sin 0 ni 15. Se usa el mismo criterio para armar el
 * link del teléfono del cliente en el bloque "Entrega".
 */
const BUSINESS_WHATSAPP_URL = "https://wa.me/5491130226565";

function buildCustomerWhatsAppUrl(areaCode: string | null | undefined, localNumber: string | null | undefined): string | null {
  const cleanArea = (areaCode ?? "").replace(/\D/g, "").replace(/^0+/, "");
  const cleanLocal = (localNumber ?? "").replace(/\D/g, "").replace(/^15/, "");
  if (!cleanArea || !cleanLocal) return null;
  return `https://wa.me/549${cleanArea}${cleanLocal}`;
}

/** Formato de teléfono para los mails: área + número separados por espacio, sin paréntesis. */
function formatCustomerPhone(areaCode: string | null | undefined, localNumber: string | null | undefined): string {
  return [areaCode, localNumber].filter(Boolean).join(" ");
}

/** "Tarjeta" blanca con título en mayúsculas, estilo de bloque de app-order-summary. */
function emailBlockHtml(title: string, bodyHtml: string, subtitle?: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.cardBg};border-radius:12px;">
    <tr><td style="padding:16px 18px;font-family:Arial,sans-serif;">
      <div style="font-family:${EMAIL_FONT_IMPACT};font-size:16px;color:${EMAIL_COLORS.title};text-transform:uppercase;letter-spacing:.03em;">${title}${subtitle ? ` <span style="font-family:Arial,sans-serif;font-weight:normal;text-transform:none;color:${EMAIL_COLORS.label};font-size:12px;">— ${subtitle}</span>` : ""}</div>
      <div style="height:10px;line-height:10px;font-size:1px;">&nbsp;</div>
      ${bodyHtml}
    </td></tr>
  </table>
  <div style="height:10px;line-height:10px;font-size:1px;">&nbsp;</div>`;
}

/** Fila label/valor dentro de un bloque. mono=true para datos para copiar a mano (alias, CVU, etc). */
function emailFieldRowHtml(label: string, valueHtml: string, options?: { mono?: boolean; bold?: boolean; valueColor?: string }): string {
  const fontFamily = options?.mono ? "'Courier New',Consolas,monospace" : "Arial,sans-serif";
  const fontWeight = options?.bold ? "bold" : "normal";
  const color = options?.valueColor ?? EMAIL_COLORS.value;
  return `<tr>
    <td style="padding:4px 6px 4px 0;font-family:Arial,sans-serif;font-size:13px;color:${EMAIL_COLORS.label};vertical-align:top;width:40%;">${label}</td>
    <td style="padding:4px 0;font-family:${fontFamily};font-size:13px;color:${color};font-weight:${fontWeight};text-align:right;">${valueHtml}</td>
  </tr>`;
}

function emailFieldsTableHtml(rowsHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>`;
}

function buildEmailHeaderHtml(orderLabel: string, logoUrl: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:center;padding-bottom:16px;font-family:Arial,sans-serif;">
    <img src="${logoUrl}" alt="Brotalia" width="120" style="width:120px;max-width:120px;height:auto;margin-bottom:12px;">
    <div style="font-family:${EMAIL_FONT_IMPACT};font-size:22px;color:${EMAIL_COLORS.title};letter-spacing:.02em;">DETALLE DEL PEDIDO</div>
    <div style="font-size:12px;color:${EMAIL_COLORS.label};margin-top:4px;">${orderLabel}</div>
  </td></tr></table>`;
}

function buildEmailFooterHtml(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.cardBg};border-radius:12px;">
    <tr><td style="padding:16px 18px;text-align:center;font-family:Arial,sans-serif;">
      <div style="color:${EMAIL_COLORS.accent};font-weight:bold;font-size:14px;">¡Gracias por tu compra!</div>
    </td></tr>
  </table>`;
}

function buildEmailWrapperHtml(headerHtml: string, blocksHtml: string, footerHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.wrapperBg};padding:24px 0;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:640px;width:100%;">
        <tr><td style="background-color:${EMAIL_COLORS.pageBg};border-radius:16px;padding:20px;">
          ${headerHtml}
          ${blocksHtml}
          ${footerHtml}
        </td></tr>
      </table>
    </td></tr>
  </table>`;
}

function buildEmbalajeSection(shippingBoxes: ShippingBox[]): { html: string; textLines: string[] } {
  const html = shippingBoxes.length
    ? `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f2f2f2;">
        <div style="font-size:12px;color:${EMAIL_COLORS.label};margin-bottom:4px;">Embalaje</div>
        ${emailFieldsTableHtml(shippingBoxes.map(b => emailFieldRowHtml(`${b.count} x ${escapeHtmlForEmail(b.boxModelName)}`, `${b.widthCm} x ${b.lengthCm} x ${b.heightCm} cm`)).join(""))}
      </div>`
    : "";
  const textLines = shippingBoxes.length
    ? ["", "Embalaje:", ...shippingBoxes.map(b => `- ${b.count} x ${b.boxModelName} (${b.widthCm} x ${b.lengthCm} x ${b.heightCm} cm)`)]
    : [];
  return { html, textLines };
}

interface EntregaAddressInput {
  recipient_name: string | null;
  street: string | null;
  street_number: string | null;
  floor?: string | null;
  apartment?: string | null;
  locality: string | null;
  county: string | null;
  province: string | null;
  postal_code: string | null;
}

interface EntregaBlockInput {
  method: "pickup" | "delivery" | "coordinar" | null;
  address: EntregaAddressInput | null;
  shippingAmountArs: number;
  shippingBoxes: ShippingBox[];
  customerPhone: string;
  customerWaUrl: string | null;
}

/**
 * Bloque "Entrega", compartido entre el mail de confirmación de
 * transferencia y el de Mercado Pago: mismas 3 ramas (coordinar / pickup /
 * delivery), mismo copy y misma tabla de campos + embalaje.
 */
function buildEntregaBlock(input: EntregaBlockInput): { html: string; text: string } {
  const embalaje = buildEmbalajeSection(input.shippingBoxes);
  let bodyHtml: string;
  let textLines: string[];

  if (input.method === "coordinar") {
    bodyHtml = `<p style="margin:0 0 8px;font-size:13px;color:${EMAIL_COLORS.value};line-height:1.5;">Coordinamos el método de envío (transporte, micro o expreso), el costo y los tiempos según tu localidad por WhatsApp.</p>
      <p style="margin:0;font-size:13px;"><a href="${BUSINESS_WHATSAPP_URL}" style="color:${EMAIL_COLORS.accent};font-weight:bold;text-decoration:none;">💬 Escribinos por WhatsApp: +54 9 11 3022-6565</a></p>`;
    textLines = [
      "Coordinamos el envío (transporte, micro o expreso), costo y tiempos por WhatsApp.",
      `WhatsApp: ${BUSINESS_WHATSAPP_URL}`
    ];
  } else if (input.method === "pickup" || !input.address) {
    bodyHtml = `<p style="margin:0 0 8px;font-size:13px;color:${EMAIL_COLORS.value};line-height:1.5;">Retiro en <strong>Portela 875, Flores, CABA</strong> o <strong>Roosevelt 1935, Belgrano, CABA</strong>, según disponibilidad. Coordiná día y horario por WhatsApp.</p>
      <p style="margin:0;font-size:13px;"><a href="${BUSINESS_WHATSAPP_URL}" style="color:${EMAIL_COLORS.accent};font-weight:bold;text-decoration:none;">📦 Escribinos por WhatsApp: +54 9 11 3022-6565</a></p>`;
    textLines = [
      "Retiro en Portela 875, Flores, CABA o Roosevelt 1935, Belgrano, CABA (coordinar día y horario).",
      `WhatsApp: ${BUSINESS_WHATSAPP_URL}`
    ];
  } else {
    const address = input.address;
    const direccionCompleta = [
      `${escapeHtmlForEmail(address.street)} ${escapeHtmlForEmail(address.street_number)}`,
      address.floor ? `Piso ${escapeHtmlForEmail(address.floor)}` : null,
      address.apartment ? `Depto ${escapeHtmlForEmail(address.apartment)}` : null
    ].filter(Boolean).join(", ");
    bodyHtml = emailFieldsTableHtml([
      emailFieldRowHtml("Destinatario", escapeHtmlForEmail(address.recipient_name)),
      emailFieldRowHtml("Dirección", direccionCompleta),
      emailFieldRowHtml("Localidad", `${escapeHtmlForEmail(address.locality)}${address.county ? ` (${escapeHtmlForEmail(address.county)})` : ""}`),
      emailFieldRowHtml("Provincia", escapeHtmlForEmail(address.province)),
      emailFieldRowHtml("Código Postal", escapeHtmlForEmail(address.postal_code)),
      emailFieldRowHtml("Costo de envío", `$${formatArsAmount(input.shippingAmountArs)}`),
      ...(input.customerWaUrl ? [emailFieldRowHtml("Contacto (WhatsApp)", `<a href="${input.customerWaUrl}" style="color:${EMAIL_COLORS.accent};text-decoration:none;font-weight:bold;">${escapeHtmlForEmail(input.customerPhone)}</a>`)] : [])
    ].join("")) + embalaje.html;
    textLines = [
      `Destinatario: ${address.recipient_name ?? ""}`,
      `Dirección: ${direccionCompleta}`,
      `Localidad: ${address.locality ?? ""}${address.county ? ` (${address.county})` : ""}`,
      `Provincia: ${address.province ?? ""}`,
      `Código Postal: ${address.postal_code ?? ""}`,
      `Costo de envío: $${formatArsAmount(input.shippingAmountArs)}`,
      ...(input.customerWaUrl ? [`Contacto (WhatsApp): ${input.customerPhone} (${input.customerWaUrl})`] : []),
      ...embalaje.textLines
    ];
  }

  return {
    html: emailBlockHtml("Entrega", bodyHtml),
    text: ["ENTREGA", ...textLines].join("\n")
  };
}

/**
 * Fila "TOTAL" + nota destacada al pie del bloque "Totales", compartida
 * entre ambos generadores (monto en acento naranja + nota en gris claro).
 * El estilo de la nota (itálica o no, margen) se pasa por parámetro porque
 * difiere levemente entre el mail de transferencia (IVA incluido/no
 * incluido, en itálica) y el de Mercado Pago (cotización usada, sin
 * itálica) — no queríamos alterar ese detalle visual existente.
 */
function buildTotalRowHtml(totalArs: number | string, noteHtml: string, noteStyle: string): string {
  return `<div style="margin-top:10px;padding-top:10px;border-top:1px solid #f2f2f2;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
      <td style="font-family:${EMAIL_FONT_IMPACT};font-size:16px;color:${EMAIL_COLORS.title};">TOTAL</td>
      <td style="text-align:right;font-family:${EMAIL_FONT_IMPACT};font-size:22px;color:${EMAIL_COLORS.accent};">$${formatArsAmount(totalArs)}</td>
    </tr></table>
    <div style="text-align:right;font-family:Arial,sans-serif;font-size:11px;color:${EMAIL_COLORS.label};${noteStyle}">${noteHtml}</div>
  </div>`;
}

/**
 * Mail de confirmación para pedidos con method de pago "transferencia",
 * disparado desde handleCreateOrder (routes/orders.ts) justo después de
 * crear la orden. Antes salía desde el frontend (checkout.component.ts) vía
 * emailjs.send() con la public key de EmailJS expuesta en el browser; se
 * movió al backend porque Resend no tiene un equivalente de "public key"
 * seguro para el cliente (la API key es un secreto completo).
 *
 * Estructura en 5 bloques (Datos personales / Productos / Entrega / Método
 * de pago / Totales), estilo visual tomado de app-order-summary — ver
 * EMAIL_COLORS más arriba.
 */
export async function sendTransferOrderConfirmationEmail(env: Env, input: TransferOrderEmailInput): Promise<void> {
  try {
    const supabase = getSupabase(env);
    const { data: transferAccountsData, error: transferAccountsError } = await supabase
      .from("payment_transfer_info")
      .select("bank_name, alias, cvu, cbu, account_number, account_holder_name, account_holder_tax_id, position")
      .eq("active", true)
      // El checkout (checkout.component.ts) solo muestra la cuenta de Mercado
      // Pago aunque payment_transfer_info tenga más filas activas (ej. Banco
      // Nación); el mail tiene que reflejar lo mismo que ve el cliente en
      // pantalla al elegir "transferencia".
      .eq("bank_name", "Mercado Pago")
      .order("position", { ascending: true });
    if (transferAccountsError) {
      console.error("Unable to load payment_transfer_info for confirmation email:", transferAccountsError.message);
    }
    const transferAccounts = (transferAccountsData ?? []) as unknown as Array<{
      bank_name: string;
      alias: string;
      cvu: string | null;
      cbu: string | null;
      account_number: string | null;
      account_holder_name: string;
      account_holder_tax_id: string;
    }>;

    // ---- Datos personales ----
    const phone = formatCustomerPhone(input.customer.codigoArea, input.customer.celular);
    const datosPersonalesHtml = emailBlockHtml("Datos personales", emailFieldsTableHtml([
      emailFieldRowHtml("Nombre", escapeHtmlForEmail(input.customer.nombre)),
      emailFieldRowHtml("Email", escapeHtmlForEmail(input.customer.email)),
      emailFieldRowHtml("Teléfono", escapeHtmlForEmail(phone)),
      ...(input.customer.cuit ? [emailFieldRowHtml("CUIT", escapeHtmlForEmail(input.customer.cuit))] : [])
    ].join("")));
    const datosPersonalesText = [
      "DATOS PERSONALES",
      `Nombre: ${input.customer.nombre}`,
      `Email: ${input.customer.email}`,
      `Teléfono: ${phone}`,
      ...(input.customer.cuit ? [`CUIT: ${input.customer.cuit}`] : [])
    ].join("\n");

    // ---- Productos (mismo agrupado por nombre de siempre) ----
    const productGroupsByName = new Map<string, { totalUnits: number; subtotal: number; skus: string[] }>();
    for (const item of input.items) {
      const units = (item.units_per_pack || 1) * item.quantity;
      const existing = productGroupsByName.get(item.product_name);
      if (existing) {
        existing.totalUnits += units;
        existing.subtotal += item.subtotal_ars;
        existing.skus.push(item.sku);
      } else {
        productGroupsByName.set(item.product_name, { totalUnits: units, subtotal: item.subtotal_ars, skus: [item.sku] });
      }
    }
    const productosTableHtml = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Producto</th>
        <th style="text-align:center;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Unidades</th>
        <th style="text-align:right;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Subtotal</th>
      </tr></thead>
      <tbody>${Array.from(productGroupsByName.entries()).map(([name, g]) => `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;color:${EMAIL_COLORS.title};"><strong>${escapeHtmlForEmail(name)}</strong><br><span style="font-size:11px;color:${EMAIL_COLORS.label};">SKU: ${escapeHtmlForEmail(g.skus.join(", "))}</span></td>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:center;color:${EMAIL_COLORS.value};">${g.totalUnits} u.</td>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:right;color:${EMAIL_COLORS.value};">$${formatArsAmount(g.subtotal)}</td>
      </tr>`).join("")}</tbody>
    </table>`;
    const productosHtml = emailBlockHtml("Productos", productosTableHtml);
    const productosText = [
      "PRODUCTOS",
      ...Array.from(productGroupsByName.entries()).map(([name, g]) => `- ${name} (SKU ${g.skus.join(", ")}) x${g.totalUnits} u. - Subtotal: $${formatArsAmount(g.subtotal)}`)
    ].join("\n");

    // ---- Entrega (dirección/retiro/coordinar + WhatsApp del cliente + embalaje) ----
    const address = input.shipping.address;
    const customerWaUrl = buildCustomerWhatsAppUrl(input.customer.codigoArea, input.customer.celular);
    const entrega = buildEntregaBlock({
      method: input.shipping.method,
      address: address ?? null,
      shippingAmountArs: input.shippingAmountArs,
      shippingBoxes: input.shippingBoxes,
      customerPhone: phone,
      customerWaUrl
    });
    const entregaHtml = entrega.html;
    const entregaText = entrega.text;

    // ---- Método de pago (una sola cuenta: Mercado Pago) ----
    const cuentaRowsHtml = transferAccounts.map(c => emailFieldsTableHtml([
      emailFieldRowHtml("Alias", escapeHtmlForEmail(c.alias), { mono: true }),
      ...(c.cvu ? [emailFieldRowHtml("CVU", escapeHtmlForEmail(c.cvu), { mono: true })] : []),
      ...(c.cbu ? [emailFieldRowHtml("CBU", escapeHtmlForEmail(c.cbu), { mono: true })] : []),
      emailFieldRowHtml("Titular", escapeHtmlForEmail(c.account_holder_name), { mono: true }),
      emailFieldRowHtml("CUIT", escapeHtmlForEmail(c.account_holder_tax_id), { mono: true }),
      ...(c.account_number ? [emailFieldRowHtml("Cuenta", escapeHtmlForEmail(c.account_number), { mono: true })] : [])
    ].join(""))).join("");
    const pagoHtml = emailBlockHtml("Método de pago", `${cuentaRowsHtml}
      <p style="margin:14px 0 0;padding:12px;background-color:#e9f7ef;border-radius:8px;text-align:center;font-family:Arial,sans-serif;font-size:12px;color:#1e7e34;font-weight:bold;">Recibido o acreditado el pago se procesa el pedido. El comprobante podés enviarlo por WhatsApp al +54 9 11 3022-6565.</p>`, "Transferencia bancaria");
    const pagoText = [
      "MÉTODO DE PAGO — Transferencia bancaria",
      ...transferAccounts.flatMap(c => [
        `Alias: ${c.alias}`,
        ...(c.cvu ? [`CVU: ${c.cvu}`] : []),
        ...(c.cbu ? [`CBU: ${c.cbu}`] : []),
        `Titular: ${c.account_holder_name}`,
        `CUIT: ${c.account_holder_tax_id}`,
        ...(c.account_number ? [`Cuenta: ${c.account_number}`] : [])
      ]),
      "",
      "Recibido o acreditado el pago se procesa el pedido. El comprobante podés enviarlo por WhatsApp al +54 9 11 3022-6565."
    ].join("\n");

    // ---- Totales (mismo cálculo de descuento por volumen de siempre) ----
    const subtotalSinDescuento = input.items.reduce((sum, item) => sum + item.price_ars_no_discount * item.quantity, 0);
    const totalesRowsHtml = emailFieldsTableHtml([
      emailFieldRowHtml("Subtotal", `$${formatArsAmount(subtotalSinDescuento)}`),
      ...(input.volumeDiscountPercentage > 0 ? [emailFieldRowHtml("Descuento", `-${input.volumeDiscountPercentage}%`, { valueColor: "#1e7e34", bold: true })] : []),
      ...(input.shippingAmountArs > 0 ? [emailFieldRowHtml("Envío", `$${formatArsAmount(input.shippingAmountArs)}`)] : []),
      ...(input.paymentCommissionPercentage > 0 ? [emailFieldRowHtml("Transferencia", `-${input.paymentCommissionPercentage}%`, { valueColor: "#1e7e34", bold: true })] : [])
    ].join(""));
    const totalesHtml = emailBlockHtml("Totales", `${totalesRowsHtml}
      ${buildTotalRowHtml(input.totalArs, escapeHtmlForEmail(input.vatLabel), "font-style:italic;margin-top:2px;")}`);
    const totalesText = [
      "TOTALES",
      `Subtotal: $${formatArsAmount(subtotalSinDescuento)}`,
      ...(input.volumeDiscountPercentage > 0 ? [`Descuento: -${input.volumeDiscountPercentage}%`] : []),
      ...(input.shippingAmountArs > 0 ? [`Envío: $${formatArsAmount(input.shippingAmountArs)}`] : []),
      ...(input.paymentCommissionPercentage > 0 ? [`Transferencia: -${input.paymentCommissionPercentage}%`] : []),
      `TOTAL: $${formatArsAmount(input.totalArs)}`,
      input.vatLabel
    ].join("\n");

    // ---- Ensamblado ----
    const blocksHtml = [datosPersonalesHtml, productosHtml, entregaHtml, pagoHtml, totalesHtml].join("");
    const logoUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/assets/images/brotalia-iso-00.png`;
    const mensajeHtml = buildEmailWrapperHtml(buildEmailHeaderHtml(`Pedido #${input.orderRef}`, logoUrl), blocksHtml, buildEmailFooterHtml());
    const mensajeText = [
      "DETALLE DEL PEDIDO",
      `Pedido #${input.orderRef}`,
      "",
      datosPersonalesText,
      "",
      productosText,
      "",
      entregaText,
      "",
      pagoText,
      "",
      totalesText,
      "",
      "¡Gracias por tu compra!"
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [input.customer.email],
        cc: ["integralesproveedores@gmail.com"],
        subject: `Orden de Compra #${input.orderRef}`,
        html: mensajeHtml,
        text: mensajeText
      })
    });

    if (!response.ok) {
      throw new Error(`Resend request failed with status ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    console.error("Unable to send transfer order confirmation email", error);
  }
}

/**
 * Mail de confirmación de pago aprobado por Mercado Pago, disparado desde
 * MercadoPagoCheckoutService.processPayment. Misma estructura en 5 bloques
 * que sendTransferOrderConfirmationEmail (Datos personales / Productos /
 * Entrega / Método de pago / Totales). El embalaje se recalcula acá a
 * partir de order_items + código postal (ver más abajo), igual que en el
 * mail de transferencia. El % de descuento por volumen NO se muestra
 * porque no se persiste en ningún lado (ni en orders ni en order_items):
 * reconstruirlo con exactitud requeriría una migración que guarde ese dato
 * al crear la orden, o recalcularlo con el pricing vigente al momento del
 * mail (que puede no coincidir con el vigente al momento de la compra).
 */
export async function sendMercadoPagoOrderConfirmationEmail(
  env: Env,
  orderId: string,
  payment: MercadoPagoPaymentResponse
): Promise<void> {
  try {
    const supabase = getSupabase(env);
    const [orderResult, itemsResult, customerResult, addressResult] = await Promise.all([
      supabase
        .from("orders")
        .select("id, total_amount, subtotal_amount, shipping_amount, exchange_rate_used")
        .eq("id", orderId)
        .single(),
      supabase
        .from("order_items")
        .select(`
          product_variant_id,
          quantity,
          unit_price,
          product_variants (
            sku,
            units_per_pack,
            products (
              id,
              name
            )
          )
        `)
        .eq("order_id", orderId),
      supabase
        .from("order_customers")
        .select("full_name, email, tax_id, phone_area_code, phone_number")
        .eq("order_id", orderId)
        .single(),
      supabase
        .from("order_addresses")
        .select("recipient_name, postal_code, province, locality, county, street, street_number, floor, apartment, shipping_method")
        .eq("order_id", orderId)
        .maybeSingle()
    ]);

    if (orderResult.error || !orderResult.data) {
      throw new Error(`Unable to load order confirmation data: ${orderResult.error?.message ?? "order not found"}`);
    }
    if (itemsResult.error) {
      throw new Error(`Unable to load order items for email: ${itemsResult.error.message}`);
    }
    if (customerResult.error || !customerResult.data) {
      throw new Error(`Unable to load order customer for email: ${customerResult.error?.message ?? "customer not found"}`);
    }
    if (addressResult.error) {
      // No bloqueamos el envío del mail por esto: preferimos mandar el mail
      // sin la sección de envío (fallback a "pickup"/coordinación) antes que
      // no mandar nada.
      console.error("Unable to load order_addresses for confirmation email:", addressResult.error.message);
    }

    const order = orderResult.data as unknown as OrderConfirmationOrderRow;
    const items = (itemsResult.data ?? []) as unknown as OrderConfirmationItemRow[];
    const customer = customerResult.data as unknown as OrderConfirmationCustomerRow;
    const address = (addressResult.data ?? null) as unknown as OrderConfirmationAddressRow | null;
    const getVariant = (value: OrderConfirmationVariantRow | OrderConfirmationVariantRow[] | null) =>
      Array.isArray(value) ? value[0] : value;
    const getProduct = (value: OrderConfirmationProductRow | OrderConfirmationProductRow[] | null) =>
      Array.isArray(value) ? value[0] : value;
    const phone = formatCustomerPhone(customer.phone_area_code, customer.phone_number);
    const customerWaUrl = buildCustomerWhatsAppUrl(customer.phone_area_code, customer.phone_number);

    // ---- Datos personales ----
    const datosPersonalesHtml = emailBlockHtml("Datos personales", emailFieldsTableHtml([
      emailFieldRowHtml("Nombre", escapeHtmlForEmail(customer.full_name)),
      emailFieldRowHtml("Email", escapeHtmlForEmail(customer.email)),
      emailFieldRowHtml("Teléfono", escapeHtmlForEmail(phone)),
      ...(customer.tax_id ? [emailFieldRowHtml("CUIT", escapeHtmlForEmail(customer.tax_id))] : [])
    ].join("")));
    const datosPersonalesText = [
      "DATOS PERSONALES",
      `Nombre: ${customer.full_name}`,
      `Email: ${customer.email}`,
      `Teléfono: ${phone}`,
      ...(customer.tax_id ? [`CUIT: ${customer.tax_id}`] : [])
    ].join("\n");

    // ---- Productos (misma data/columnas de siempre, solo cambia el estilo) ----
    const productosRowsHtml = items.map(item => {
      const variant = getVariant(item.product_variants);
      const product = getProduct(variant?.products ?? null);
      const quantity = Number(item.quantity);
      const unitPrice = Number(item.unit_price);
      return `<tr>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;color:${EMAIL_COLORS.title};"><strong>${escapeHtmlForEmail(product?.name ?? "")}</strong><br><span style="font-size:11px;color:${EMAIL_COLORS.label};">SKU: ${escapeHtmlForEmail(variant?.sku ?? "")}</span></td>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:center;color:${EMAIL_COLORS.value};">${quantity}</td>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:right;color:${EMAIL_COLORS.value};">$${formatArsAmount(unitPrice)}</td>
        <td style="padding:8px 0;border-bottom:1px solid #f2f2f2;text-align:right;color:${EMAIL_COLORS.value};">$${formatArsAmount(unitPrice * quantity)}</td>
      </tr>`;
    }).join("");
    const productosHtml = emailBlockHtml("Productos", `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;font-size:13px;">
      <thead><tr>
        <th style="text-align:left;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Producto</th>
        <th style="text-align:center;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Cant.</th>
        <th style="text-align:right;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Precio</th>
        <th style="text-align:right;padding:6px 0;border-bottom:1px solid #eee;color:${EMAIL_COLORS.label};font-weight:normal;">Subtotal</th>
      </tr></thead>
      <tbody>${productosRowsHtml}</tbody>
    </table>`);
    const productosText = [
      "PRODUCTOS",
      ...items.map(item => {
        const variant = getVariant(item.product_variants);
        const product = getProduct(variant?.products ?? null);
        const quantity = Number(item.quantity);
        const unitPrice = Number(item.unit_price);
        return `- ${product?.name ?? ""} (SKU ${variant?.sku ?? ""}) x${quantity} - Precio unitario: $${formatArsAmount(unitPrice)} - Subtotal: $${formatArsAmount(unitPrice * quantity)}`;
      })
    ].join("\n");

    // ---- Embalaje (recalculado a partir de order_items + código postal; no se
    // persiste en la orden, así que se reconstruye igual que en el mail de
    // transferencia en vez de agregar una columna nueva solo para esto) ----
    let shippingBoxes: ShippingBox[] = [];
    if (address?.shipping_method === "delivery" && address.postal_code) {
      const productGroups = Array.from(items.reduce((groups, item) => {
        const variant = getVariant(item.product_variants);
        const product = getProduct(variant?.products ?? null);
        if (!product?.id) return groups;
        const unitsPerPack = Number(variant?.units_per_pack ?? 1);
        groups.set(product.id, (groups.get(product.id) ?? 0) + Number(item.quantity) * unitsPerPack);
        return groups;
      }, new Map<string, number>()), ([product_id, units]) => ({ product_id, units }));
      try {
        const resolution = await resolveShippingRate(env, address.postal_code, productGroups);
        shippingBoxes = resolution?.boxes ?? [];
      } catch (error) {
        console.error("Unable to recompute shipping boxes for confirmation email:", error);
      }
    }

    // ---- Entrega ----
    const entrega = buildEntregaBlock({
      method: address?.shipping_method ?? null,
      address: address,
      shippingAmountArs: Number(order.shipping_amount),
      shippingBoxes,
      customerPhone: phone,
      customerWaUrl
    });
    const entregaHtml = entrega.html;
    const entregaText = entrega.text;

    // ---- Método de pago (ya aprobado, sin datos de cuenta) ----
    const pagoHtml = emailBlockHtml("Método de pago", emailFieldsTableHtml([
      emailFieldRowHtml("ID de pago", escapeHtmlForEmail(payment.id), { mono: true }),
      emailFieldRowHtml("Estado", escapeHtmlForEmail(payment.status)),
      emailFieldRowHtml("Fecha de aprobación", escapeHtmlForEmail(payment.date_approved))
    ].join("")), "Mercado Pago");
    const pagoText = [
      "MÉTODO DE PAGO — Mercado Pago",
      `ID de pago: ${payment.id}`,
      `Estado: ${payment.status}`,
      `Fecha de aprobación: ${payment.date_approved}`
    ].join("\n");

    // ---- Totales ----
    const totalesHtml = emailBlockHtml("Totales", `${emailFieldsTableHtml(emailFieldRowHtml("Subtotal", `$${formatArsAmount(order.subtotal_amount)}`))}
        ${buildTotalRowHtml(order.total_amount, `Cotización usada: $${formatArsAmount(order.exchange_rate_used)}`, "margin-top:6px;")}`);
    const totalesText = [
      "TOTALES",
      `Subtotal: $${formatArsAmount(order.subtotal_amount)}`,
      `TOTAL: $${formatArsAmount(order.total_amount)} ARS`,
      `Cotización usada: $${formatArsAmount(order.exchange_rate_used)}`
    ].join("\n");

    // ---- Ensamblado ----
    const blocksHtml = [datosPersonalesHtml, productosHtml, entregaHtml, pagoHtml, totalesHtml].join("");
    const logoUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/assets/images/brotalia-iso-00.png`;
    const mensajeHtml = buildEmailWrapperHtml(buildEmailHeaderHtml(`Pedido #${orderId}`, logoUrl), blocksHtml, buildEmailFooterHtml());
    const mensajeText = [
      "DETALLE DEL PEDIDO",
      `Pedido #${orderId}`,
      "",
      datosPersonalesText,
      "",
      productosText,
      "",
      entregaText,
      "",
      pagoText,
      "",
      totalesText,
      "",
      "¡Gracias por tu compra!"
    ].join("\n");

    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.RESEND_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from: EMAIL_FROM,
        to: [customer.email],
        cc: ["integralesproveedores@gmail.com"],
        subject: `Confirmación de tu pedido #${orderId} - Brotalia`,
        html: mensajeHtml,
        text: mensajeText
      })
    });

    if (!response.ok) {
      throw new Error(`Resend request failed with status ${response.status}: ${await response.text()}`);
    }
  } catch (error) {
    console.error("Unable to send order confirmation email", error);
  }
}
