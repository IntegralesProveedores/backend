import { getSupabase } from "../services/db";
import { getPricingConfig, getCachedTaxes, getCachedVolumeDiscounts } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, cleanProduct } from "../lib/products";
import { RouteContext } from "../lib/router";
import { enforceRateLimit } from "../lib/rate-limit";
import { parseIntParam } from "../lib/request";

function cleanCategory(category: any) {
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

export async function handleCategories({ env, url, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "categories/list");
  if (limited) return limited;

  try {
    const supabase = getSupabase(env);
    const asTree = url.searchParams.get("tree") === "1";

    const { data, error } = await supabase
      .from("categories")
      .select("id, name, slug, description, parent_id, position, created_at")
      .order("position", { ascending: true })
      .order("name", { ascending: true });

    if (error) {
      return errorResponse("Unable to load categories", 500, { supabase_error: error.message });
    }

    const cleaned = (data ?? []).map(cleanCategory);
    return jsonResponse(asTree ? buildCategoryTree(cleaned) : cleaned, 200, 60);
  } catch (e: any) {
    return errorResponse("Unable to load categories", 500, { original_message: e.message, stack: e.stack });
  }
}

export async function handleCategoryBySlug({ env, params, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "categories/get");
  if (limited) return limited;

  try {
    const supabase = getSupabase(env);
    const { slug } = params;

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
  } catch (e: any) {
    return errorResponse("Unable to load category", 500, { original_message: e.message, stack: e.stack });
  }
}

export async function handleCategoryProducts({ env, params, url, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "categories/products");
  if (limited) return limited;

  const supabase = getSupabase(env);
  const { slug } = params;

  const page = parseIntParam(url.searchParams.get("page"), 1, 1);
  const limit = parseIntParam(url.searchParams.get("limit"), 20, 1, 50);
  const offset = (page - 1) * limit;

  const { data: category, error: catError } = await supabase
    .from("categories")
    .select("id, name, slug, parent_id")
    .eq("slug", slug)
    .single();

  if (catError || !category) {
    return errorResponse("Category not found", 404);
  }

  const [{ data: children }, { data: parent }, pricingConfig, taxes, volumeDiscounts] = await Promise.all([
    supabase.from("categories").select("id").eq("parent_id", category.id),
    category.parent_id
      ? supabase.from("categories").select("id, name, slug").eq("id", category.parent_id).maybeSingle()
      : Promise.resolve({ data: null }),
    getPricingConfig(env),
    getCachedTaxes(env),
    getCachedVolumeDiscounts(env)
  ]);

  const categoryIds = [category.id, ...(children ?? []).map((c: any) => c.id)];

  // Filtrar sobre el embed product_categories (sin !inner) no descarta productos:
  // solo vacía el embed. Por eso se resuelven primero los ids de producto.
  const { data: links, error: linksError } = await supabase
    .from("product_categories")
    .select("product_id")
    .in("category_id", categoryIds);

  if (linksError) {
    return errorResponse("Unable to load category products", 500, { supabase_error: linksError.message });
  }

  const productIds = [...new Set((links ?? []).map((l: any) => l.product_id))];

  let productsResult = await supabase
    .from("products")
    .select(PRODUCT_SUMMARY_SELECT, { count: "exact" })
    .in("id", productIds)
    .eq("active", true)
    .is("deleted_at", null)
    .order("volume_cc", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: products, error, count } = productsResult;

  if (error) {
    return errorResponse("Unable to load category products", 500, { supabase_error: error.message });
  }

  return jsonResponse({
    category: { ...cleanCategory(category), parent: parent ?? null },
    items: (products ?? []).map((p: any) => cleanProduct(p, pricingConfig.exchangeRate, pricingConfig.markups.minorista, 1, taxes, volumeDiscounts, pricingConfig.packagingCost ?? 0, pricingConfig.paymentCommissionPercentage)),
    pagination: {
      total: count || 0,
      page,
      limit,
      total_pages: Math.ceil((count || 0) / limit)
    }
  }, 200, 60);
}
