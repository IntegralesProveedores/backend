import { getSupabase } from "../services/db";
import { getExchangeRate, getPricingConfig } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, PRODUCT_DETAIL_SELECT, cleanProduct } from "../lib/products";
import { RouteContext } from "../lib/router";
import { resolveTenantContext } from "../lib/tenant";
import { RawProduct } from "../lib/types";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Handlers para la gestión de productos con soporte Multi-tenancy.
// POR QUÉ:  Aisla datos por 'tenant_slug' y aplica márgenes dinámicos según el Host.
// CUIDADO:  El header 'host' es crítico para la resolución del contexto.
// ─────────────────────────────────────────────────────────────

/**
 * GET /products
 * Soporta aislamiento por Tenant, filtros SQL, Summary projection y Paginación.
 */
export async function handleProducts({ env, url, request }: RouteContext) {
  try {
    const supabase = getSupabase(env);
    
    // 1. Resolución de Contexto de Tienda (Multi-tenancy)
    let tenant;
    try {
      tenant = resolveTenantContext(url.host);
    } catch (e: any) {
      throw new Error(`resolveTenantContext failed: ${e.message}`);
    }

    // Parámetros de filtrado y paginación
    const categorySlug = url.searchParams.get("category");
    const inStock = url.searchParams.get("in_stock") === "1";
    const quantity = Math.max(1, parseInt(url.searchParams.get("quantity") || "1"));
    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
    const offset = (page - 1) * limit;

    // 2. Obtener configuración comercial de precios
    let pricingConfig;
    try {
      pricingConfig = await getPricingConfig(env);
    } catch (e: any) {
      console.error("getPricingConfig failed, using fallback:", e.message);
      pricingConfig = {
        exchangeRate: 1481.94,
        embalageCost: 745.56,
        markups: {
          integrales: { minorista: 20, mayorista: 15 },
          brotalia: { minorista: 40, mayorista: 30 }
        }
      };
    }

    const activeMarkups = pricingConfig.markups[tenant.id as "integrales" | "brotalia"] || { minorista: 20, mayorista: 15 };
    tenant = {
      ...tenant,
      markupMinorista: activeMarkups.minorista,
      markupMayorista: activeMarkups.mayorista
    };

    // 3. Construir query base
    const { data, error, count } = await supabase
      .from("products")
      .select(PRODUCT_SUMMARY_SELECT, { count: "exact" })
      .eq("active", true)
      .is("deleted_at", null)
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) throw new Error(`Supabase query failed: ${error.message}`);

    // Carga dinámica de impuestos y descuentos por volumen
    const { data: dbTaxes } = await supabase
      .from("pricing_taxes")
      .select("name, percentage, is_computable, is_active")
      .eq("is_active", true);

    const { data: dbDiscounts } = await supabase
      .from("pricing_volume_discounts")
      .select("min_quantity, factor")
      .order("min_quantity", { ascending: false });

    const taxes = (dbTaxes ?? []).map(t => ({
      name: t.name,
      percentage: Number(t.percentage),
      is_computable: t.is_computable,
      is_active: t.is_active
    }));
    // ─────────────────────────────────────────────────────────────
    // QUÉ HACE: Valida que existan reglas de impuestos en la base de datos.
    // POR QUÉ:  Evita calcular precios incorrectos si la tabla de impuestos está vacía.
    // CUIDADO:  Requiere que la base de datos contenga al menos una regla activa.
    // ─────────────────────────────────────────────────────────────
    if (taxes.length === 0) {
      throw new Error('No se encontraron reglas de impuestos en la base de datos');
    }

    const volumeDiscounts = (dbDiscounts ?? []).map(d => ({
      min: Number(d.min_quantity),
      factor: Number(d.factor)
    }));
    if (volumeDiscounts.length === 0) {
      volumeDiscounts.push(
        { min: 31, factor: 1.25 },
        { min: 21, factor: 1.20 },
        { min: 11, factor: 1.15 },
        { min: 6,  factor: 1.10 },
        { min: 3,  factor: 1.05 },
        { min: 1,  factor: 1.00 }
      );
    }

    // 4. Mapeo con Tipado Estricto
    const cleaned = (data as unknown as RawProduct[] ?? []).map(p => 
      cleanProduct(p, pricingConfig.exchangeRate, tenant, pricingConfig.embalageCost, quantity, taxes, volumeDiscounts)
    );

    return jsonResponse({
      items: cleaned,
      tenant: {
        id: tenant.id,
        markup_applied: tenant.markupMinorista
      },
      pagination: {
        total: count || 0,
        page,
        limit,
        total_pages: Math.ceil((count || 0) / limit)
      }
    });
  } catch (e: any) {
    return errorResponse(`handleProducts Error: ${e.message}`, 500, { stack: e.stack });
  }
}

/**
 * GET /products/:slug
 * Detalle de producto con aislamiento por Tenant.
 */
export async function handleProductBySlug({ env, params, request, url }: RouteContext) {
  const { slug } = params;
  const quantity = Math.max(1, parseInt(url.searchParams.get("quantity") || "1"));
  
  // 1. Resolución de Contexto de Tienda (Multi-tenancy) - Estrategia Robusta
  let tenant = resolveTenantContext(url.host);

  // Validación de slug
  if (!slug || slug.length > 200 || !/^[a-z0-9-]+$/.test(slug)) {
    return errorResponse("Invalid slug format", 400);
  }

  const supabase = getSupabase(env);
  
  // Obtener configuración comercial de precios
  let pricingConfig;
  try {
    pricingConfig = await getPricingConfig(env);
  } catch (e: any) {
    console.error("getPricingConfig failed, using fallback:", e.message);
    pricingConfig = {
      exchangeRate: 1481.94,
      embalageCost: 745.56,
      markups: {
        integrales: { minorista: 20, mayorista: 15 },
        brotalia: { minorista: 40, mayorista: 30 }
      }
    };
  }

  const activeMarkups = pricingConfig.markups[tenant.id as "integrales" | "brotalia"] || { minorista: 20, mayorista: 15 };
  tenant = {
    ...tenant,
    markupMinorista: activeMarkups.minorista,
    markupMayorista: activeMarkups.mayorista
  };

  const { data, error } = await supabase
    .from("products")
    .select(PRODUCT_DETAIL_SELECT)
    .eq("slug", slug)
    .eq("active", true)
    .is("deleted_at", null)
    .single();

  if (error || !data) return errorResponse("Product not found", 404);

  // Carga dinámica de impuestos y descuentos por volumen
  const { data: dbTaxes } = await supabase
    .from("pricing_taxes")
    .select("name, percentage, is_computable, is_active")
    .eq("is_active", true);

  const { data: dbDiscounts } = await supabase
    .from("pricing_volume_discounts")
    .select("min_quantity, factor")
    .order("min_quantity", { ascending: false });

  const taxes = (dbTaxes ?? []).map(t => ({
    name: t.name,
    percentage: Number(t.percentage),
    is_computable: t.is_computable,
    is_active: t.is_active
  }));
  // ─────────────────────────────────────────────────────────────
  // QUÉ HACE: Carga impuestos fallback desde pricing.ts.
  // POR QUÉ:  Evita fallas si la tabla pricing_taxes está vacía, centralizando la configuración.
  // CUIDADO:  Depende directamente de DEFAULT_TAX_RULES.
  // ─────────────────────────────────────────────────────────────
    if (taxes.length === 0) {
      throw new Error('No se encontraron reglas de impuestos en la base de datos');
    }
	
  const volumeDiscounts = (dbDiscounts ?? []).map(d => ({
    min: Number(d.min_quantity),
    factor: Number(d.factor)
  }));
  if (volumeDiscounts.length === 0) {
    volumeDiscounts.push(
      { min: 31, factor: 1.25 },
      { min: 21, factor: 1.20 },
      { min: 11, factor: 1.15 },
      { min: 6,  factor: 1.10 },
      { min: 3,  factor: 1.05 },
      { min: 1,  factor: 1.00 }
    );
  }

  return jsonResponse({
    ...cleanProduct(data as unknown as RawProduct, pricingConfig.exchangeRate, tenant, pricingConfig.embalageCost, quantity, taxes, volumeDiscounts),
    tenant: {
      id: tenant.id,
      markup_applied: tenant.markupMinorista
    }
  });
}
