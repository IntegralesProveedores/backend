import { TENANT_MARKUPS } from "./pricing";

export interface TenantContext {
  id: string;
  host: string;
  markupMinorista: number;
  markupMayorista: number;
}

export function resolveTenantContext(host: string = ''): TenantContext {
  if (host.includes('brotalia')) {
    return {
      id: 'brotalia',
      host: 'brotalia.com.ar',
      markupMinorista: TENANT_MARKUPS.brotalia.markupMinorista,
      markupMayorista: TENANT_MARKUPS.brotalia.markupMayorista
    };
  }
  return {
    id: 'integrales',
    host: 'integralesproveedores.workers.dev',
    markupMinorista: TENANT_MARKUPS.integrales.markupMinorista,
    markupMayorista: TENANT_MARKUPS.integrales.markupMayorista
  };
}