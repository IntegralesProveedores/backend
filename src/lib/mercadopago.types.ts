export type MercadoPagoPaymentStatus =
  | "approved"
  | "pending"
  | "in_process"
  | "rejected"
  | "cancelled"
  | "refunded"
  | "charged_back";

export interface MercadoPagoPreferenceItem {
  id: string;
  title: string;
  description?: string;
  quantity: number;
  currency_id: "ARS";
  unit_price: number;
}

export interface MercadoPagoPayer {
  name: string;
  email: string;
  phone?: {
    area_code: string;
    number: string;
  };
  identification?: {
    type: "CUIT";
    number: string;
  };
}

export interface MercadoPagoPreferenceRequest {
  external_reference: string;
  notification_url: string;
  back_urls: {
    success: string;
    pending: string;
    failure: string;
  };
  auto_return: "approved";
  binary_mode: boolean;
  statement_descriptor: string;
  expiration_date_from: string;
  expiration_date_to: string;
  payer: MercadoPagoPayer;
  items: MercadoPagoPreferenceItem[];
  metadata: Record<string, string>;
}

export interface MercadoPagoPreferenceResponse {
  id: string;
  init_point: string;
  sandbox_init_point?: string;
  external_reference?: string;
}

export interface MercadoPagoPaymentResponse {
  id: number;
  status: MercadoPagoPaymentStatus;
  status_detail?: string;
  transaction_amount: number;
  currency_id: string;
  external_reference: string | null;
  date_approved: string | null;
  date_created: string;
  date_last_updated: string;
  metadata?: Record<string, unknown>;
}

export interface MercadoPagoApiErrorPayload {
  message?: string;
  error?: string;
  cause?: Array<{
    code?: string;
    description?: string;
  }>;
}

export interface MercadoPagoWebhookSignature {
  timestamp: string;
  value: string;
}
