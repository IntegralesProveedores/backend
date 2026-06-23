import { getSupabase } from "../services/db";
import { getExchangeRate } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, cleanProduct } from "../lib/products";
import { RouteContext } from "../lib/router";
import { resolveTenantContext } from "../lib/tenant";
import { RawProduct, RawCategory } from "../lib/types";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Handlers para la gestión de categorías y productos por categoría.
// POR QUÉ:  Soporta multi-tenancy y filtrado avanzado (B3, B5, B8).
// CUIDADO:  Las categorías son compartidas, pero los productos se filtran por tenant.
// ─────────────────────────────────────────────────────────────

function cleanCategory(category: RawCategory | any) {
  return {
    id: category.id,
    name: category.name,
    slug: category.slug,
    description: category.description,
    parent_id: category.parent_id ?? null,
    position: category.position ?? 0,
    created_at: category.created_at
  };
}

/**
 * Construye árbol anidado desde lista plana.
 */
function buildCategoryTree(categories: any[]): any[] {
  const map: Record<string, any> = {};
  const roots: any[] = [];

  for (const cat of categories) {
    map[cat.id] = { ...cat, children: [] };
  }
  for (const cat of categories) {
    if (cat.parent_id && map[cat.parent_id]) {
      map[cat.parent_id].children.push(map[cat.id]);
    } else {
      roots.push(map[cat.id]);
    }
  }
  return roots;
}

/**
 * GET /categories
 */
export async function handleCategories({ env, url }: RouteContext) {
  const supabase = getSupabase(env);
  const asTree = url.searchParams.get("tree") === "1";

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug, description, parent_id, position, created_at")
    .order("position", { ascending: true })
    .order("name", { ascending: true });

  if (error) {
    return errorResponse(error.message, 500);
  }

  const cleaned = (data ?? []).map(cleanCategory);
  return jsonResponse(asTree ? buildCategoryTree(cleaned) : cleaned);
}

/**
 * GET /categories/:slug
 */
export async function handleCategoryBySlug({ env, params }: RouteContext) {
  const { slug } = params;
  const supabase = getSupabase(env);

  const { data, error } = await supabase
    .from("categories")
    .select("id, name, slug, description, parent_id, position, created_at")
    .eq("slug", slug)
    .single();

  if (error || !data) {
    return errorResponse("Category not found", 404);
  }

  const { data: children } = await supabase
    .from("categories")
    .select("id, name, slug, description, parent_id, position, created_at")
    .eq("parent_id", data.id)
    .order("position", { ascending: true });

  return jsonResponse({
    ...cleanCategory(data),
    children: (children ?? []).map(cleanCategory)
  });
}

/**
 * GET /categories/:slug/products
 * Soporta multi-tenancy, filtros y paginación real (B3, B5)
 */
export async function handleCategoryProducts({ env, params, url, request }: RouteContext) {
  const { slug } = params;
  const supabase = getSupabase(env);
  
  // 1. Resolución de Contexto de Tienda (Multi-tenancy)
  const tenant = resolveTenantContext(url.host);

  // Parámetros de paginación
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
  const offset = (page - 1) * limit;

  // 2. Buscar categoría por slug
  const { data: category, error: catError } = await supabase
    .from("categories")
    .select("id, name, slug, parent_id")
    .eq("slug", slug)
    .single();

  if (catError || !category) {
    return errorResponse("Category not found", 404);
  }

  // 3. Recolectar IDs: categoría actual + sus hijos directos
  const { data: children } = await supabase
    .from("categories")
    .select("id")
    .eq("parent_id", category.id);

  const categoryIds = [
    category.id,
    ...(children ?? []).map((c: any) => c.id)
  ];

  // 4. Obtener tipo de cambio (F1)
  const exchangeRate = await getExchangeRate(env);

  // 5. Traer productos en SQL con filtros, paginación y AISLAMIENTO por Tenant
  let query = supabase
    .from("products")
    .select(PRODUCT_SUMMARY_SELECT, { count: "exact" })
    .eq("tenant_slug", tenant.id) // Aislamiento de datos
    .filter("product_categories.category_id", "in", `(${categoryIds.join(',')})`)
    .eq("active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: products, error, count } = await query;

  if (error) {
    return errorResponse(error.message, 500);
  }

  // 6. Mapeo con Tipado Estricto y Precios Dinámicos
  const cleanedProducts = (products as unknown as RawProduct[] ?? []).map(p => 
    cleanProduct(p, exchangeRate, tenant)
  );

  return jsonResponse({
    category: cleanCategory(category),
    items: cleanedProducts,
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
}
