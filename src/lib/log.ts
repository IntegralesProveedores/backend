import { AsyncLocalStorage } from "node:async_hooks";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Correlation-id. Cada request tiene un request_id y, cuando se conoce,
//           el order_ref (external_reference) de la orden. logEvent los agrega a
//           cada log, así se sigue request → orden → pago buscando un solo valor.
// CUIDADO:  Fuera de un request (cron) no hay contexto: logEvent funciona igual,
//           solo sin request_id.
// ─────────────────────────────────────────────────────────────

interface LogContext {
  requestId: string;
  orderRef?: string;
}

const storage = new AsyncLocalStorage<LogContext>();

export function runWithRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

export function getRequestId(): string | undefined {
  return storage.getStore()?.requestId;
}

/** Asocia la orden al request actual: los logs siguientes llevan su order_ref. */
export function setOrderRef(orderRef: string | null | undefined): void {
  const store = storage.getStore();
  if (store && orderRef) store.orderRef = orderRef;
}

export function logEvent(
  level: "log" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {}
): void {
  const store = storage.getStore();
  console[level](JSON.stringify({
    event,
    request_id: store?.requestId,
    order_ref: store?.orderRef,
    ...fields
  }));
}
