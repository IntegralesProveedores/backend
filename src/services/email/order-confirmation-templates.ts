import { PaymentCustomerInput } from "../../lib/payment-input.validation";
import { MercadoPagoPaymentResponse } from "../../lib/mercadopago.types";
import { PackagingBox } from "../shipping.service";
import { ShippingInput } from "../../lib/payment-input.validation";
import { sendEmail } from "./resend.client";
import {
  firstRow,
  loadMercadoPagoOrderEmailData,
  loadTransferAccounts,
  MercadoPagoOrderEmailData,
  TransferAccountRow
} from "./order-email.data";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Los dos mails de confirmación de orden (transferencia y Mercado
//           Pago): el armado del HTML/texto (buildTransferOrderEmail,
//           buildMercadoPagoOrderEmail y sus helpers, sin consultas ni envíos)
//           y las funciones send* que cargan los datos (order-email.data.ts),
//           arman el mail y lo mandan (resend.client.ts).
// POR QUÉ:  Antes este archivo también consultaba Supabase y hablaba con
//           Resend; separado, el armado se puede probar sin base ni red.
// CUIDADO:  El cuerpo del mail replica app-order-summary (frontend):
//           mismos bloques, mismo orden, mismas jerarquías y mismo
//           formato de montos. Si cambia el resumen del checkout, hay que
//           reflejarlo acá (ver buildSummaryBlocks).
// ─────────────────────────────────────────────────────────────

export interface TransferOrderEmailItem {
  product_name: string;
  sku: string;
  quantity: number;
  units_per_pack: number;
  subtotal_ars: number;
  price_ars_no_discount: number;
  price_ars_no_tax: number;
  image_url: string | null;
}

export interface TransferOrderEmailInput {
  orderRef: string;
  customer: PaymentCustomerInput;
  items: TransferOrderEmailItem[];
  shipping: ShippingInput;
  shippingAmountArs: number;
  /** Cajas del pedido (embalaje), con o sin envío; el precio del embalaje ya está repartido
   *  dentro de cada item.subtotal_ars, este bloque solo se usa para mostrar la lista. */
  packagingBoxes: PackagingBox[];
  totalArs: number;
  volumeDiscountPercentage: number;
  vatLabel: string;
  /** Descuento por pagar con transferencia (los precios de lista ya incluyen el costo de Mercado Pago). */
  transferDiscount: { percentage: number; amountArs: number };
}

const escapeHtmlForEmail = (value: unknown): string => String(value ?? "")
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&#39;");

/** Mismo formato que el pipe currencyArs del frontend: "$ 1.438.600" (sin decimales). */
const formatArs = (value: number | string): string =>
  `$ ${Math.round(Number(value || 0)).toLocaleString("es-AR", { maximumFractionDigits: 0 })}`;

/**
 * Paleta y jerarquía tomadas de app-order-summary (frontend), la misma
 * referencia visual del checkout: rótulos de bloque en mayúsculas con la
 * fuente de títulos, montos y nombres de producto en verde (--color-title),
 * textos secundarios en --color-text-muted. Ver frontend/src/styles/tokens.css.
 *
 * Los mails arman todo con tablas + estilos inline (nada de flexbox/grid/
 * variables CSS/clases externas) porque Outlook y otros clientes de correo
 * no las soportan de forma confiable.
 */
const EMAIL_COLORS = {
  title: "#2b3033",
  green: "#2e5a36",
  label: "#7a8178",
  value: "#5c6468",
  accent: "#e07b39",
  cardBg: "#ffffff",
  pageBg: "#fff4dc",
  wrapperBg: "#f4f4f4",
  divider: "#eeeeee"
};

/**
 * Dos familias en todo el mail, como en el sitio (Oswald para títulos/montos,
 * Inter para texto), sin depender de webfonts (los clientes de correo no las
 * cargan de forma confiable). No se usa ninguna otra (nada de monoespaciada).
 */
const FONT_HEADING = "Impact,'Arial Narrow Bold','Arial Black',sans-serif";
const FONT_BODY = "Arial,Helvetica,sans-serif";

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

/**
 * Rango estimado de entrega, misma regla que getEstimatedDeliveryRange del
 * frontend (2 a 5 días hábiles, sin feriados), calculado en hora argentina.
 */
function estimatedDeliveryLabel(now: Date = new Date(), minDays = 2, maxDays = 5): string {
  const argentinaNow = new Date(now.toLocaleString("en-US", { timeZone: "America/Argentina/Buenos_Aires" }));
  const addBusinessDays = (days: number): Date => {
    const result = new Date(argentinaNow);
    let remaining = days;
    while (remaining > 0) {
      result.setDate(result.getDate() + 1);
      const dayOfWeek = result.getDay();
      if (dayOfWeek !== 0 && dayOfWeek !== 6) remaining--;
    }
    return result;
  };
  const start = addBusinessDays(minDays);
  const end = addBusinessDays(maxDays);
  const dayAndMonth = (date: Date) => date.toLocaleDateString("es-AR", { day: "numeric", month: "long" });
  const startLabel = start.getMonth() === end.getMonth() ? String(start.getDate()) : dayAndMonth(start);
  return `Entre el ${startLabel} y el ${dayAndMonth(end)}`;
}

/** Miniatura del producto: misma variante "-thumb" del sitio, con URL absoluta. */
function emailThumbUrl(env: Env, imageUrl: string | null | undefined): string | null {
  if (!imageUrl) return null;
  if (!imageUrl.startsWith("/assets/images/")) return imageUrl;
  const thumb = imageUrl.replace(/\.(webp|jpe?g|png)$/i, "-thumb.webp");
  return `${env.APP_BASE_URL.replace(/\/$/, "")}${thumb}`;
}

// ---------- Piezas visuales (equivalentes a h6 / data / small del resumen) ----------

const SPACER = `<div style="height:10px;line-height:10px;font-size:1px;">&nbsp;</div>`;

/** Rótulo de bloque (h6 del resumen): fuente de títulos, mayúsculas. */
function labelHtml(text: string): string {
  return `<span style="font-family:${FONT_HEADING};font-size:15px;color:${EMAIL_COLORS.title};text-transform:uppercase;letter-spacing:.03em;">${text}</span>`;
}

/** Monto (data del resumen): fuente de títulos en verde. */
function amountHtml(text: string, size = 18): string {
  return `<span style="font-family:${FONT_HEADING};font-size:${size}px;color:${EMAIL_COLORS.green};">${text}</span>`;
}

/** Texto chico y apagado (small del resumen). */
function smallHtml(text: string): string {
  return `<span style="font-family:${FONT_BODY};font-size:12px;color:${EMAIL_COLORS.label};">${text}</span>`;
}

/** Tarjeta blanca (section del resumen). */
function cardHtml(innerHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;background-color:${EMAIL_COLORS.cardBg};border-radius:12px;">
    <tr><td style="padding:12px 16px;font-family:${FONT_BODY};">${innerHtml}</td></tr>
  </table>${SPACER}`;
}

/** Fila izquierda/derecha (summary-row del resumen). */
function rowHtml(leftHtml: string, rightHtml: string, options?: { topDivider?: boolean; padding?: string }): string {
  const border = options?.topDivider ? `border-top:1px solid ${EMAIL_COLORS.divider};` : "";
  const padding = options?.padding ?? "4px 0";
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="${border}"><tr>
    <td style="padding:${padding};vertical-align:top;text-align:left;">${leftHtml}</td>
    <td style="padding:${padding};vertical-align:top;text-align:right;">${rightHtml}</td>
  </tr></table>`;
}

/** Fila label/valor de datos de contacto, dirección y cuenta bancaria. Misma fuente que el resto. */
function emailFieldRowHtml(label: string, valueHtml: string, options?: { bold?: boolean; valueColor?: string }): string {
  const fontWeight = options?.bold ? "bold" : "normal";
  const color = options?.valueColor ?? EMAIL_COLORS.value;
  return `<tr>
    <td style="padding:3px 6px 3px 0;font-family:${FONT_BODY};font-size:13px;color:${EMAIL_COLORS.label};vertical-align:top;width:40%;">${label}</td>
    <td style="padding:3px 0;font-family:${FONT_BODY};font-size:13px;color:${color};font-weight:${fontWeight};text-align:right;">${valueHtml}</td>
  </tr>`;
}

function emailFieldsTableHtml(rowsHtml: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${rowsHtml}</table>`;
}

/** Tarjeta con rótulo y filas label/valor (Datos personales). */
function emailBlockHtml(title: string, bodyHtml: string): string {
  return cardHtml(`${labelHtml(title)}
      <div style="height:6px;line-height:6px;font-size:1px;">&nbsp;</div>
      ${bodyHtml}`);
}

function buildEmailHeaderHtml(orderLabel: string, logoUrl: string): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="text-align:center;padding-bottom:16px;font-family:${FONT_BODY};">
    <img src="${logoUrl}" alt="Brotalia" width="120" style="width:120px;max-width:120px;height:auto;margin-bottom:12px;">
    <div style="font-family:${FONT_HEADING};font-size:22px;color:${EMAIL_COLORS.title};letter-spacing:.02em;">DETALLE DEL PEDIDO</div>
    <div style="font-size:12px;color:${EMAIL_COLORS.label};margin-top:4px;">${orderLabel}</div>
  </td></tr></table>`;
}

function buildEmailFooterHtml(): string {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${EMAIL_COLORS.cardBg};border-radius:12px;">
    <tr><td style="padding:16px 18px;text-align:center;font-family:${FONT_BODY};">
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

// ---------- Resumen del pedido (réplica de app-order-summary) ----------

interface SummaryItem {
  name: string;
  totalUnits: number;
  /** Subtotal que se muestra en la línea (en el resumen: a precio de lista, sin descuento). */
  subtotalArs: number;
  imageUrl: string | null;
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

interface SummaryModel {
  items: SummaryItem[];
  /** Solo si se conoce el subtotal a precio de lista: habilita las filas Subtotal / Descuento. */
  subtotalNoDiscountArs: number | null;
  volumeDiscountPercentage: number;
  /** Fila "Productos": subtotal ya descontado, sin envío. */
  productsTotalArs: number;
  /** "Sin impuestos Nacionales"; null si no está disponible. */
  subtotalNoTaxArs: number | null;
  vatLabel: string;
  /** Solo para la lista de cajas: el embalaje ya está incluido en `productsTotalArs`. */
  packagingBoxes: PackagingBox[];
  entrega: {
    method: "pickup" | "delivery" | "coordinar" | null;
    address: EntregaAddressInput | null;
    shippingAmountArs: number;
    customerPhone: string;
    customerWaUrl: string | null;
  };
  pago: {
    /** Medio de pago, ej. "Transferencia bancaria" o "Mercado Pago". */
    methodLabel: string;
    /** Descuento por pagar con transferencia (fila "Pago Transferencia  −10%"). */
    transferDiscountPercentage: number;
    transferDiscountAmountArs: number;
    detailsHtml: string;
    detailsText: string[];
  };
  /** Comisión de Mercado Pago, si hubo. */
  commission: { percentage: number; amountArs: number } | null;
  totalArs: number;
}

/** Bloque "Productos": miniatura, nombre, unidades y subtotal por línea + desglose + total de productos. */
function buildItemsCard(env: Env, model: SummaryModel): { html: string; text: string[] } {
  const linesHtml = model.items.map((item, index) => {
    const thumb = emailThumbUrl(env, item.imageUrl);
    const border = index > 0 ? `border-top:1px solid ${EMAIL_COLORS.divider};` : "";
    return `<tr>
      <td width="44" style="width:44px;padding:5px 8px 5px 0;vertical-align:middle;${border}">${thumb ? `<img src="${escapeHtmlForEmail(thumb)}" alt="${escapeHtmlForEmail(item.name)}" width="36" height="36" style="display:block;width:36px;height:36px;border-radius:4px;object-fit:cover;">` : ""}</td>
      <td style="padding:5px 0;vertical-align:middle;${border}">
        <div style="font-family:${FONT_HEADING};font-size:15px;color:${EMAIL_COLORS.green};text-transform:uppercase;line-height:1.1;">${escapeHtmlForEmail(item.name)}</div>
        ${smallHtml(`${item.totalUnits} u.`)}
      </td>
      <td style="padding:5px 0;vertical-align:middle;text-align:right;font-family:${FONT_BODY};font-size:16px;font-weight:bold;color:${EMAIL_COLORS.title};white-space:nowrap;${border}">${formatArs(item.subtotalArs)}</td>
    </tr>`;
  }).join("");

  const hasDiscountRows = model.subtotalNoDiscountArs !== null && model.volumeDiscountPercentage > 0;
  const discountHtml = hasDiscountRows
    ? `${rowHtml(labelHtml("Subtotal"), amountHtml(formatArs(model.subtotalNoDiscountArs ?? 0)))}
       ${rowHtml(labelHtml("Descuento"), amountHtml(`&minus;${model.volumeDiscountPercentage}%`))}`
    : "";

  const productsNotes = [
    smallHtml(escapeHtmlForEmail(model.vatLabel)),
    ...(model.subtotalNoTaxArs !== null ? [smallHtml(`Sin impuestos Nacionales: ${formatArs(model.subtotalNoTaxArs)}`)] : [])
  ].join("<br>");

  const html = cardHtml(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${linesHtml}</table>
    <div style="height:6px;line-height:6px;font-size:1px;">&nbsp;</div>
    ${discountHtml}
    ${rowHtml(labelHtml("Productos"), `${amountHtml(formatArs(model.productsTotalArs))}<br>${productsNotes}`, { topDivider: true, padding: "8px 0 2px" })}`);

  const text = [
    "PRODUCTOS",
    ...model.items.map(item => `- ${item.name} (${item.totalUnits} u.): ${formatArs(item.subtotalArs)}`),
    ...(hasDiscountRows ? [`Subtotal: ${formatArs(model.subtotalNoDiscountArs ?? 0)}`, `Descuento: -${model.volumeDiscountPercentage}%`] : []),
    `Productos: ${formatArs(model.productsTotalArs)} (${model.vatLabel})`,
    ...(model.subtotalNoTaxArs !== null ? [`Sin impuestos Nacionales: ${formatArs(model.subtotalNoTaxArs)}`] : [])
  ];
  return { html, text };
}

/** Bloque "Embalaje": cantidad x modelo de caja y sus medidas (sin precio: ya está en Productos). */
function buildPackagingCard(boxes: PackagingBox[]): { html: string; text: string[] } {
  if (!boxes.length) return { html: "", text: [] };
  const rows = boxes.map(b => rowHtml(
    `<span style="font-family:${FONT_BODY};font-size:13px;font-weight:bold;color:${EMAIL_COLORS.title};">${b.count} x ${escapeHtmlForEmail(b.boxModelName)}</span>`,
    `<span style="font-family:${FONT_BODY};font-size:12px;color:${EMAIL_COLORS.value};">${b.widthCm} &times; ${b.lengthCm} &times; ${b.heightCm} cm.</span>`,
    { padding: "2px 0" }
  )).join("");
  return {
    html: cardHtml(`${labelHtml("Embalaje")}
      <div style="height:4px;line-height:4px;font-size:1px;">&nbsp;</div>
      ${rows}`),
    text: ["EMBALAJE", ...boxes.map(b => `- ${b.count} x ${b.boxModelName} (${b.widthCm} x ${b.lengthCm} x ${b.heightCm} cm)`)]
  };
}

/**
 * Bloque "Entrega": rótulo + fechas a la izquierda y costo a la derecha (como
 * el resumen), y debajo el detalle (dirección / retiro / coordinar) que el
 * resumen no muestra pero el cliente necesita en el comprobante.
 */
function buildEntregaCard(entrega: SummaryModel["entrega"]): { html: string; text: string[] } {
  const isDelivery = entrega.method === "delivery" && !!entrega.address;
  const rightHtml = isDelivery
    ? (entrega.shippingAmountArs > 0 ? amountHtml(formatArs(entrega.shippingAmountArs)) : amountHtml("A confirmar"))
    : amountHtml(entrega.method === "coordinar" ? "Coordinar" : "Retiro");
  const rightText = isDelivery
    ? (entrega.shippingAmountArs > 0 ? formatArs(entrega.shippingAmountArs) : "A confirmar")
    : (entrega.method === "coordinar" ? "Coordinar" : "Retiro");
  const deliveryDates = isDelivery ? estimatedDeliveryLabel() : "";

  let detailsHtml: string;
  let detailsText: string[];

  if (entrega.method === "coordinar") {
    detailsHtml = `<p style="margin:0 0 6px;font-family:${FONT_BODY};font-size:13px;color:${EMAIL_COLORS.value};line-height:1.5;">Coordinamos el método de envío (transporte, micro o expreso), el costo y los tiempos según tu localidad por WhatsApp.</p>
      <p style="margin:0;font-family:${FONT_BODY};font-size:13px;"><a href="${BUSINESS_WHATSAPP_URL}" style="color:${EMAIL_COLORS.accent};font-weight:bold;text-decoration:none;">Escribinos por WhatsApp: +54 9 11 3022-6565</a></p>`;
    detailsText = [
      "Coordinamos el envío (transporte, micro o expreso), costo y tiempos por WhatsApp.",
      `WhatsApp: ${BUSINESS_WHATSAPP_URL}`
    ];
  } else if (!isDelivery) {
    detailsHtml = `<p style="margin:0 0 6px;font-family:${FONT_BODY};font-size:13px;color:${EMAIL_COLORS.value};line-height:1.5;">Retiro en <strong>Portela 875, Flores, CABA</strong> o <strong>Roosevelt 1935, Belgrano, CABA</strong>, según disponibilidad. Coordiná día y horario por WhatsApp.</p>
      <p style="margin:0;font-family:${FONT_BODY};font-size:13px;"><a href="${BUSINESS_WHATSAPP_URL}" style="color:${EMAIL_COLORS.accent};font-weight:bold;text-decoration:none;">Escribinos por WhatsApp: +54 9 11 3022-6565</a></p>`;
    detailsText = [
      "Retiro en Portela 875, Flores, CABA o Roosevelt 1935, Belgrano, CABA (coordinar día y horario).",
      `WhatsApp: ${BUSINESS_WHATSAPP_URL}`
    ];
  } else {
    const address = entrega.address as EntregaAddressInput;
    const direccionCompleta = [
      `${escapeHtmlForEmail(address.street)} ${escapeHtmlForEmail(address.street_number)}`,
      address.floor ? `Piso ${escapeHtmlForEmail(address.floor)}` : null,
      address.apartment ? `Depto ${escapeHtmlForEmail(address.apartment)}` : null
    ].filter(Boolean).join(", ");
    const localidad = `${escapeHtmlForEmail(address.locality)}${address.county ? ` (${escapeHtmlForEmail(address.county)})` : ""}`;
    detailsHtml = emailFieldsTableHtml([
      emailFieldRowHtml("Destinatario", escapeHtmlForEmail(address.recipient_name)),
      emailFieldRowHtml("Dirección", direccionCompleta),
      emailFieldRowHtml("Localidad", localidad),
      emailFieldRowHtml("Provincia", escapeHtmlForEmail(address.province)),
      emailFieldRowHtml("Código Postal", escapeHtmlForEmail(address.postal_code)),
      ...(entrega.customerWaUrl ? [emailFieldRowHtml("Contacto (WhatsApp)", `<a href="${entrega.customerWaUrl}" style="color:${EMAIL_COLORS.accent};text-decoration:none;font-weight:bold;">${escapeHtmlForEmail(entrega.customerPhone)}</a>`)] : [])
    ].join(""));
    detailsText = [
      `Destinatario: ${address.recipient_name ?? ""}`,
      `Dirección: ${direccionCompleta}`,
      `Localidad: ${address.locality ?? ""}${address.county ? ` (${address.county})` : ""}`,
      `Provincia: ${address.province ?? ""}`,
      `Código Postal: ${address.postal_code ?? ""}`,
      ...(entrega.customerWaUrl ? [`Contacto (WhatsApp): ${entrega.customerPhone} (${entrega.customerWaUrl})`] : [])
    ];
  }

  const html = cardHtml(`${rowHtml(
    `${labelHtml("Entrega")}${deliveryDates ? `<br>${smallHtml(deliveryDates)}` : ""}`,
    rightHtml,
    { padding: "2px 0" }
  )}
    <div style="height:8px;line-height:8px;font-size:1px;">&nbsp;</div>
    ${detailsHtml}`);

  return {
    html,
    text: [`ENTREGA: ${rightText}${deliveryDates ? ` (${deliveryDates})` : ""}`, ...detailsText]
  };
}

/** Bloque "Pago": medio de pago (y descuento por transferencia) + datos de la cuenta o del pago. */
function buildPagoCard(pago: SummaryModel["pago"]): { html: string; text: string[] } {
  const hasTransferDiscount = pago.transferDiscountPercentage > 0;
  const html = cardHtml(`${rowHtml(
    `${labelHtml("Pago")}<br>${smallHtml(escapeHtmlForEmail(pago.methodLabel))}`,
    hasTransferDiscount ? `${amountHtml(`&minus;${formatArs(pago.transferDiscountAmountArs)}`)}<br>${smallHtml(`&minus;${pago.transferDiscountPercentage}%`)}` : "",
    { padding: "2px 0" }
  )}
    <div style="height:8px;line-height:8px;font-size:1px;">&nbsp;</div>
    ${pago.detailsHtml}`);
  return {
    html,
    text: [
      `PAGO: ${pago.methodLabel}${hasTransferDiscount ? ` (-${pago.transferDiscountPercentage}%: -${formatArs(pago.transferDiscountAmountArs)})` : ""}`,
      ...pago.detailsText
    ]
  };
}

/** Bloque "Comisión Mercado Pago". */
function buildCommissionCard(commission: SummaryModel["commission"]): { html: string; text: string[] } {
  if (!commission || commission.amountArs <= 0) return { html: "", text: [] };
  return {
    html: cardHtml(rowHtml(labelHtml(`Comisión Mercado Pago (${commission.percentage}%)`), amountHtml(formatArs(commission.amountArs)), { padding: "2px 0" })),
    text: [`COMISIÓN MERCADO PAGO (${commission.percentage}%): ${formatArs(commission.amountArs)}`]
  };
}

/** Bloque "Total". */
function buildTotalCard(totalArs: number, vatLabel: string): { html: string; text: string[] } {
  return {
    html: cardHtml(rowHtml(
      labelHtml("Total"),
      `${amountHtml(formatArs(totalArs), 22)}<br>${smallHtml(escapeHtmlForEmail(vatLabel))}`,
      { padding: "2px 0" }
    )),
    text: [`TOTAL: ${formatArs(totalArs)}`, vatLabel]
  };
}

/** Bloques del resumen, en el mismo orden que app-order-summary. */
function buildSummaryBlocks(env: Env, model: SummaryModel): { html: string; text: string } {
  const blocks = [
    buildItemsCard(env, model),
    buildPackagingCard(model.packagingBoxes),
    buildEntregaCard(model.entrega),
    buildPagoCard(model.pago),
    buildCommissionCard(model.commission),
    buildTotalCard(model.totalArs, model.vatLabel)
  ];
  return {
    html: blocks.map(block => block.html).join(""),
    text: blocks.filter(block => block.text.length).map(block => block.text.join("\n")).join("\n\n")
  };
}

/** Bloque "Datos personales" (no está en el resumen del checkout, pero va primero en el comprobante). */
function buildDatosPersonales(fields: { nombre: string; email: string; phone: string; cuit: string | null | undefined }): { html: string; text: string } {
  const html = emailBlockHtml("Datos personales", emailFieldsTableHtml([
    emailFieldRowHtml("Nombre", escapeHtmlForEmail(fields.nombre)),
    emailFieldRowHtml("Email", escapeHtmlForEmail(fields.email)),
    emailFieldRowHtml("Teléfono", escapeHtmlForEmail(fields.phone)),
    ...(fields.cuit ? [emailFieldRowHtml("CUIT", escapeHtmlForEmail(fields.cuit))] : [])
  ].join("")));
  const text = [
    "DATOS PERSONALES",
    `Nombre: ${fields.nombre}`,
    `Email: ${fields.email}`,
    `Teléfono: ${fields.phone}`,
    ...(fields.cuit ? [`CUIT: ${fields.cuit}`] : [])
  ].join("\n");
  return { html, text };
}

function assembleEmail(env: Env, orderLabel: string, datos: { html: string; text: string }, summary: { html: string; text: string }): { html: string; text: string } {
  const logoUrl = `${env.APP_BASE_URL.replace(/\/$/, "")}/assets/images/brotalia-iso-00.png`;
  const html = buildEmailWrapperHtml(buildEmailHeaderHtml(orderLabel, logoUrl), `${datos.html}${summary.html}`, buildEmailFooterHtml());
  const text = ["DETALLE DEL PEDIDO", orderLabel, "", datos.text, "", summary.text, "", "¡Gracias por tu compra!"].join("\n");
  return { html, text };
}

/** Mail listo para enviar (asunto, HTML y texto plano). */
export interface ConfirmationEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * Mail de confirmación para pedidos con method de pago "transferencia",
 * disparado desde createTransferOrder (services/transfer-order.service.ts) justo
 * después de crear la orden. Antes salía desde el frontend (checkout.component.ts) vía
 * emailjs.send() con la public key de EmailJS expuesta en el browser; se
 * movió al backend porque Resend no tiene un equivalente de "public key"
 * seguro para el cliente (la API key es un secreto completo).
 *
 * Estructura: Datos personales + los bloques de app-order-summary (Productos
 * / Embalaje / Entrega / Pago / Total), ver buildSummaryBlocks.
 */
export async function sendTransferOrderConfirmationEmail(env: Env, input: TransferOrderEmailInput): Promise<void> {
  try {
    const transferAccounts = await loadTransferAccounts(env);
    const email = buildTransferOrderEmail(env, input, transferAccounts);
    await sendEmail(env, { to: input.customer.email, ...email });
  } catch (error) {
    console.error("Unable to send transfer order confirmation email", error);
  }
}

/** Arma el mail de un pedido por transferencia (función pura: no consulta ni envía nada). */
export function buildTransferOrderEmail(
  env: Env,
  input: TransferOrderEmailInput,
  transferAccounts: TransferAccountRow[]
): ConfirmationEmail {
  const phone = formatCustomerPhone(input.customer.codigoArea, input.customer.celular);
  const datos = buildDatosPersonales({
    nombre: input.customer.nombre,
    email: input.customer.email,
    phone,
    cuit: input.customer.cuit
  });

  // Productos agrupados por nombre; cada línea muestra el subtotal a precio de lista, como el resumen.
  const groups = new Map<string, SummaryItem>();
  for (const item of input.items) {
    const units = (item.units_per_pack || 1) * item.quantity;
    const listSubtotal = item.price_ars_no_discount * item.quantity;
    const existing = groups.get(item.product_name);
    if (existing) {
      existing.totalUnits += units;
      existing.subtotalArs += listSubtotal;
    } else {
      groups.set(item.product_name, { name: item.product_name, totalUnits: units, subtotalArs: listSubtotal, imageUrl: item.image_url });
    }
  }

  const productsTotalArs = input.items.reduce((sum, item) => sum + item.subtotal_ars, 0);
  const subtotalNoDiscountArs = input.items.reduce((sum, item) => sum + item.price_ars_no_discount * item.quantity, 0);
  const subtotalNoTaxArs = input.items.reduce((sum, item) => sum + item.price_ars_no_tax * item.quantity, 0);

  // Datos para copiar a mano: misma tipografía que el resto del mail.
  const cuentaHtml = transferAccounts.map(c => emailFieldsTableHtml([
    emailFieldRowHtml("Alias", escapeHtmlForEmail(c.alias)),
    ...(c.cvu ? [emailFieldRowHtml("CVU", escapeHtmlForEmail(c.cvu))] : []),
    ...(c.cbu ? [emailFieldRowHtml("CBU", escapeHtmlForEmail(c.cbu))] : []),
    emailFieldRowHtml("Titular", escapeHtmlForEmail(c.account_holder_name)),
    emailFieldRowHtml("CUIT", escapeHtmlForEmail(c.account_holder_tax_id)),
    ...(c.account_number ? [emailFieldRowHtml("Cuenta", escapeHtmlForEmail(c.account_number))] : [])
  ].join(""))).join("");
  const avisoPago = "Recibido o acreditado el pago se procesa el pedido. El comprobante podés enviarlo por WhatsApp al +54 9 11 3022-6565.";

  const summary = buildSummaryBlocks(env, {
    items: Array.from(groups.values()),
    subtotalNoDiscountArs,
    volumeDiscountPercentage: input.volumeDiscountPercentage,
    productsTotalArs,
    subtotalNoTaxArs,
    vatLabel: input.vatLabel,
    packagingBoxes: input.packagingBoxes,
    entrega: {
      method: input.shipping.method,
      address: input.shipping.address ?? null,
      shippingAmountArs: input.shippingAmountArs,
      customerPhone: phone,
      customerWaUrl: buildCustomerWhatsAppUrl(input.customer.codigoArea, input.customer.celular)
    },
    pago: {
      methodLabel: "Transferencia bancaria",
      transferDiscountPercentage: input.transferDiscount.percentage,
      transferDiscountAmountArs: input.transferDiscount.amountArs,
      detailsHtml: `${cuentaHtml}
          <p style="margin:12px 0 0;padding:10px 12px;background-color:#e9f7ef;border-radius:8px;text-align:center;font-family:${FONT_BODY};font-size:12px;color:#1e7e34;font-weight:bold;">${avisoPago}</p>`,
      detailsText: [
        ...transferAccounts.flatMap(c => [
          `Alias: ${c.alias}`,
          ...(c.cvu ? [`CVU: ${c.cvu}`] : []),
          ...(c.cbu ? [`CBU: ${c.cbu}`] : []),
          `Titular: ${c.account_holder_name}`,
          `CUIT: ${c.account_holder_tax_id}`,
          ...(c.account_number ? [`Cuenta: ${c.account_number}`] : [])
        ]),
        "",
        avisoPago
      ]
    },
    commission: null,
    totalArs: input.totalArs
  });

  const email = assembleEmail(env, `Pedido #${input.orderRef}`, datos, summary);
  return { subject: `Orden de Compra #${input.orderRef}`, html: email.html, text: email.text };
}

/**
 * Mail de confirmación de pago aprobado por Mercado Pago, disparado desde el
 * procesamiento del webhook. Misma estructura que el mail de transferencia. El
 * embalaje se recalcula a partir de order_items + código postal (ver
 * loadMercadoPagoOrderEmailData).
 *
 * El % de descuento por volumen NO se muestra (filas Subtotal / Descuento)
 * porque no se persiste en ningún lado (ni en orders ni en order_items):
 * reconstruirlo con exactitud requeriría una migración que guarde ese dato
 * al crear la orden, o recalcularlo con el pricing vigente al momento del
 * mail (que puede no coincidir con el vigente al momento de la compra). Por
 * lo mismo, cada línea muestra el subtotal ya descontado y no se muestra
 * "Sin impuestos Nacionales".
 */
export async function sendMercadoPagoOrderConfirmationEmail(
  env: Env,
  orderId: string,
  payment: MercadoPagoPaymentResponse
): Promise<void> {
  try {
    const data = await loadMercadoPagoOrderEmailData(env, orderId);
    const email = buildMercadoPagoOrderEmail(env, orderId, data, payment);
    await sendEmail(env, { to: data.customer.email, ...email });
  } catch (error) {
    console.error("Unable to send order confirmation email", error);
  }
}

/** Arma el mail de una orden pagada por Mercado Pago (función pura: no consulta ni envía nada). */
export function buildMercadoPagoOrderEmail(
  env: Env,
  orderId: string,
  { order, items, customer, address, taxes, packagingBoxes }: MercadoPagoOrderEmailData,
  payment: MercadoPagoPaymentResponse
): ConfirmationEmail {
  const phone = formatCustomerPhone(customer.phone_area_code, customer.phone_number);
  const customerWaUrl = buildCustomerWhatsAppUrl(customer.phone_area_code, customer.phone_number);

  const ivaTax = taxes.find(t => t.name.toUpperCase() === "IVA");
  const vatLabel = ivaTax?.is_computable ? "IVA Incluido" : "IVA no incluido";

  const datos = buildDatosPersonales({
    nombre: customer.full_name,
    email: customer.email,
    phone,
    cuit: customer.tax_id
  });

  // Productos agrupados por producto (varias presentaciones del mismo producto suman en una línea).
  const groups = new Map<string, SummaryItem>();
  for (const item of items) {
    const variant = firstRow(item.product_variants);
    const product = firstRow(variant?.products ?? null);
    const quantity = Number(item.quantity);
    const units = Number(variant?.units_per_pack ?? 1) * quantity;
    const subtotal = Number(item.unit_price) * quantity;
    const key = product?.id ?? variant?.sku ?? item.product_variant_id;
    const existing = groups.get(key);
    if (existing) {
      existing.totalUnits += units;
      existing.subtotalArs += subtotal;
    } else {
      const firstImage = [...(product?.product_images ?? [])].sort((a, b) => a.position - b.position)[0]?.image_url ?? null;
      groups.set(key, { name: product?.name ?? variant?.sku ?? "", totalUnits: units, subtotalArs: subtotal, imageUrl: firstImage });
    }
  }

  const commissionAmount = Number(order.payment_commission_amount ?? 0);
  const commissionPercentage = Number(order.payment_commission_percentage ?? 0);

  const summary = buildSummaryBlocks(env, {
    items: Array.from(groups.values()),
    subtotalNoDiscountArs: null,
    volumeDiscountPercentage: 0,
    productsTotalArs: Number(order.subtotal_amount),
    subtotalNoTaxArs: null,
    vatLabel,
    packagingBoxes,
    entrega: {
      method: address?.shipping_method ?? null,
      address,
      shippingAmountArs: Number(order.shipping_amount),
      customerPhone: phone,
      customerWaUrl
    },
    pago: {
      methodLabel: "Mercado Pago",
      transferDiscountPercentage: 0,
      transferDiscountAmountArs: 0,
      detailsHtml: emailFieldsTableHtml([
        emailFieldRowHtml("ID de pago", escapeHtmlForEmail(payment.id)),
        emailFieldRowHtml("Estado", escapeHtmlForEmail(payment.status)),
        emailFieldRowHtml("Fecha de aprobación", escapeHtmlForEmail(payment.date_approved))
      ].join("")),
      detailsText: [
        `ID de pago: ${payment.id}`,
        `Estado: ${payment.status}`,
        `Fecha de aprobación: ${payment.date_approved}`
      ]
    },
    commission: commissionAmount > 0 ? { percentage: commissionPercentage, amountArs: commissionAmount } : null,
    totalArs: Number(order.total_amount)
  });

  const email = assembleEmail(env, `Pedido #${orderId}`, datos, summary);
  return { subject: `Confirmación de tu pedido #${orderId} - Brotalia`, html: email.html, text: email.text };
}
