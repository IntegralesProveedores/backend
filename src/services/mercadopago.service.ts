import {
  MercadoPagoApiErrorPayload,
  MercadoPagoPaymentResponse,
  MercadoPagoPreferenceRequest,
  MercadoPagoPreferenceResponse,
  MercadoPagoWebhookSignature
} from "../lib/mercadopago.types";

const MERCADO_PAGO_API_URL = "https://api.mercadopago.com";
const WEBHOOK_SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export class MercadoPagoApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly payload?: MercadoPagoApiErrorPayload
  ) {
    super(message);
    this.name = "MercadoPagoApiError";
  }
}

export class MercadoPagoService {
  constructor(private readonly accessToken: string) {
    if (!accessToken.trim()) {
      throw new Error("MP_ACCESS_TOKEN is not configured");
    }
  }

  async createPreference(
    preference: MercadoPagoPreferenceRequest
  ): Promise<MercadoPagoPreferenceResponse> {
    return this.request<MercadoPagoPreferenceResponse>("/checkout/preferences", {
      method: "POST",
      body: JSON.stringify(preference)
    });
  }

  async getPayment(paymentId: string): Promise<MercadoPagoPaymentResponse> {
    return this.request<MercadoPagoPaymentResponse>(`/v1/payments/${encodeURIComponent(paymentId)}`, {
      method: "GET"
    });
  }

  async validateWebhookSignature(
    xSignature: string | null,
    xRequestId: string | null,
    dataId: string | null,
    secret: string
  ): Promise<boolean> {
    if (!xSignature || !xRequestId || !dataId || !secret) {
      console.error(JSON.stringify({
        event: "mp_signature_missing_input",
        has_x_signature: !!xSignature,
        has_x_request_id: !!xRequestId,
        has_data_id: !!dataId,
        has_secret: !!secret
      }));
      return false;
    }

    const signature = this.parseSignature(xSignature);
    if (!signature) {
      console.error(JSON.stringify({ event: "mp_signature_parse_failed", x_signature: xSignature }));
      return false;
    }

    const rawTimestamp = Number(signature.timestamp);
    const timestamp = rawTimestamp > 1_000_000_000_000
      ? Math.floor(rawTimestamp / 1_000)
      : rawTimestamp;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > WEBHOOK_SIGNATURE_TOLERANCE_SECONDS) {
      console.error(JSON.stringify({
        event: "mp_signature_timestamp_out_of_range",
        ts_received: signature.timestamp,
        now,
        diff: now - timestamp
      }));
      return false;
    }

    const normalizedDataId = dataId.toLowerCase();
    const template = `id:${normalizedDataId};request-id:${xRequestId};ts:${signature.timestamp};`;
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(template));
    const expected = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
    const isValid = this.constantTimeEqual(expected, signature.value.toLowerCase());

    if (!isValid) {
      console.error(JSON.stringify({
        event: "mp_signature_mismatch",
        template,
        expected_hash: expected,
        received_hash: signature.value,
        secret_length: secret.length,
        secret_preview: `${secret.slice(0, 4)}...${secret.slice(-4)}`
      }));
    }

    return isValid;
  }

  private parseSignature(value: string): MercadoPagoWebhookSignature | null {
    const values = new Map<string, string>();
    for (const part of value.split(",")) {
      const separator = part.indexOf("=");
      if (separator <= 0) continue;
      values.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
    }

    const timestamp = values.get("ts");
    const signature = values.get("v1");
    return timestamp && signature ? { timestamp, value: signature } : null;
  }

  private constantTimeEqual(left: string, right: string): boolean {
    if (left.length !== right.length) return false;

    let difference = 0;
    for (let index = 0; index < left.length; index++) {
      difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
    }
    return difference === 0;
  }

  private async request<T>(path: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    headers.set("Authorization", `Bearer ${this.accessToken}`);

    const response = await fetch(`${MERCADO_PAGO_API_URL}${path}`, {
      ...init,
      headers
    });

    const payload = await this.readPayload(response);
    if (!response.ok) {
      const message = payload.message ?? payload.error ?? `Mercado Pago returned HTTP ${response.status}`;
      throw new MercadoPagoApiError(message, response.status, payload);
    }

    return payload as T;
  }

  private async readPayload(response: Response): Promise<MercadoPagoApiErrorPayload> {
    const text = await response.text();
    if (!text) return {};

    try {
      return JSON.parse(text) as MercadoPagoApiErrorPayload;
    } catch {
      return { message: text };
    }
  }
}
