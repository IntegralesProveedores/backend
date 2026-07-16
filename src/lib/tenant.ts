export interface TenantContext {
  markupMinorista: number;
  markupMayorista: number;
}

export function resolveTenantContext(): TenantContext {
  return {
    markupMinorista: 40,
    markupMayorista: 30
  };
}
