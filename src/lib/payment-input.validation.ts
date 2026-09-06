// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Tipos, parseo y validación de los inputs de checkout
//           (cliente, envío, items) compartidos entre el flujo de
//           transferencia (routes/orders.ts) y el de Mercado Pago
//           (services/mercadopago-checkout.service.ts).
// POR QUÉ:  Antes vivían mezclados dentro de payment.service.ts junto
//           con persistencia, email y checkout de MP.
// ─────────────────────────────────────────────────────────────

/** Tope de ítems por orden: evita que un solo request dispare una cantidad
 *  arbitraria de consultas secuenciales a Supabase en buildOrderQuote. */
export const MAX_ORDER_ITEMS = 50;

export class PaymentInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentInputError";
  }
}

export interface PaymentCustomerInput {
  nombre: string;
  email: string;
  cuit: string;
  codigoArea: string;
  celular: string;
}

export interface PaymentItemInput {
  variant_id: string;
  quantity: number;
}

export interface ShippingAddressInput {
  recipient_name: string;
  postal_code: string;
  province: string;
  locality: string;
  county: string;
  street: string;
  street_number: string;
  floor: string;
  apartment: string;
  country: string;
  observations?: string;
}

export interface ShippingInput {
  method: "pickup" | "delivery" | "coordinar";
  address?: ShippingAddressInput;
}

export interface CreatePaymentInput {
  items: PaymentItemInput[];
  customer: PaymentCustomerInput;
  shipping: ShippingInput;
}

export const isValidEmail = (value: unknown): value is string => {
  return typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

export const isPositiveInteger = (value: unknown): value is number => {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
};

export function parseCreatePaymentInput(value: unknown): CreatePaymentInput {
  if (!value || typeof value !== "object") throw new PaymentInputError("Invalid request body");
  const record = value as Record<string, unknown>;
  const customer = record.customer;
  if (!customer || typeof customer !== "object") throw new PaymentInputError("customer is required");

  const customerRecord = customer as Record<string, unknown>;
  const items = record.items;
  if (!Array.isArray(items)) throw new PaymentInputError("items must be an array");

  return {
    items: items as PaymentItemInput[],
    customer: {
      nombre: String(customerRecord.nombre ?? "").trim(),
      email: String(customerRecord.email ?? "").trim(),
      cuit: String(customerRecord.cuit ?? "").trim(),
      codigoArea: String(customerRecord.codigoArea ?? "").trim(),
      celular: String(customerRecord.celular ?? "").trim()
    },
    shipping: parseShippingInput(record.shipping)
  };
}

export function parseShippingInput(value: unknown): ShippingInput {
  if (!value || typeof value !== "object") throw new PaymentInputError("shipping is required");
  const record = value as Record<string, unknown>;
  const method = record.method;
  if (method !== "pickup" && method !== "delivery" && method !== "coordinar") {
    throw new PaymentInputError("shipping.method must be pickup, delivery, or coordinar");
  }

  if (method === "pickup" || method === "coordinar") return { method };
  if (!record.address || typeof record.address !== "object") {
    throw new PaymentInputError("shipping.address is required for delivery");
  }

  const address = record.address as Record<string, unknown>;
  return {
    method,
    address: {
      recipient_name: String(address.recipient_name ?? "").trim(),
      postal_code: String(address.postal_code ?? "").trim(),
      province: String(address.province ?? "").trim(),
      locality: String(address.locality ?? "").trim(),
      county: String(address.county ?? "").trim(),
      street: String(address.street ?? "").trim(),
      street_number: String(address.street_number ?? "").trim(),
      floor: String(address.floor ?? "").trim(),
      apartment: String(address.apartment ?? "").trim(),
      country: String(address.country ?? "").trim(),
      observations: String(address.observations ?? "").trim()
    }
  };
}

const MAX_FREE_TEXT_LENGTH = 200;
const MAX_OBSERVATIONS_LENGTH = 500;

const SHIPPING_ADDRESS_FREE_TEXT_FIELDS: Array<keyof ShippingAddressInput> = [
  "recipient_name", "postal_code", "province", "locality", "county",
  "street", "street_number", "floor", "apartment", "country"
];

export function validateShippingInput(shipping: ShippingInput): void {
  if (!shipping || (shipping.method !== "pickup" && shipping.method !== "delivery" && shipping.method !== "coordinar")) {
    throw new PaymentInputError("shipping.method must be pickup, delivery, or coordinar");
  }
  if (shipping.method === "delivery") {
    const address = shipping.address;
    const province = address?.province.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const isCaba = province === "ciudad autonoma de buenos aires" || province === "caba";
    if (!address || !address.street || !address.street_number || !address.postal_code || !address.province || (!isCaba && !address.locality)) {
      throw new PaymentInputError("Delivery shipping requires street, street_number, postal_code, province, and locality outside CABA");
    }

    for (const field of SHIPPING_ADDRESS_FREE_TEXT_FIELDS) {
      const fieldValue = address[field];
      if (typeof fieldValue === "string" && fieldValue.length > MAX_FREE_TEXT_LENGTH) {
        throw new PaymentInputError(`shipping.address.${field} exceeds maximum length`);
      }
    }
    if (address.observations && address.observations.length > MAX_OBSERVATIONS_LENGTH) {
      throw new PaymentInputError("shipping.address.observations exceeds maximum length");
    }
  }
}

/**
 * Validación básica de formato/longitud de los datos del cliente antes de
 * persistir la orden. El CUIT es opcional (no se pide actualmente en el
 * checkout de consumidor final), pero si viene cargado debe tener 11
 * dígitos; código de área y celular deben ser sólo dígitos.
 */
export function validateCustomerInput(customer: PaymentCustomerInput): void {
  if (!customer || !customer.nombre.trim() || customer.nombre.length > MAX_FREE_TEXT_LENGTH) {
    throw new PaymentInputError("customer.nombre is required and must be a reasonable length");
  }

  if (customer.cuit) {
    const cuitDigits = customer.cuit.replace(/\D/g, "");
    if (cuitDigits.length !== 11) {
      throw new PaymentInputError("customer.cuit must contain exactly 11 digits");
    }
  }

  if (customer.codigoArea && !/^\d{1,6}$/.test(customer.codigoArea)) {
    throw new PaymentInputError("customer.codigoArea must contain only digits");
  }

  if (customer.celular && !/^\d{1,15}$/.test(customer.celular)) {
    throw new PaymentInputError("customer.celular must contain only digits");
  }
}
