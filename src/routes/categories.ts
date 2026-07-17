import { getSupabase } from "../services/db";
import { getPricingConfig } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, cleanProduct } from "../lib/products";
import { RouteContext } from "../lib/router";

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
  return jsonResponse(asTree ? buildCategoryTree(cleaned) : cleaned, 200, 60);
}

export async function handleCategoryBySlug({ env, params }: RouteContext) {
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
}

export async function handleCategoryProducts({ env, params, url }: RouteContext) {
  const supabase = getSupabase(env);
  const { slug } = params;

  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
  const offset = (page - 1) * limit;

  const { data: category, error: catError } = await supabase
    .from("categories")
    .select("id, name, slug, parent_id")
    .eq("slug", slug)
    .single();

  if (catError || !category) {
    return errorResponse("Category not found", 404);
  }

  const { data: children } = await supabase
    .from("categories")
    .select("id")
    .eq("parent_id", category.id);

  const categoryIds = [category.id, ...(children ?? []).map((c: any) => c.id)];
  const pricingConfig = await getPricingConfig(env);

  let productsResult = await supabase
    .from("products")
    .select(PRODUCT_SUMMARY_SELECT, { count: "exact" })
    .filter("product_categories.category_id", "in", `(${categoryIds.join(",")})`)
    .eq("active", true)
    .is("deleted_at", null)
    .order("name", { ascending: true })
    .range(offset, offset + limit - 1);

  const { data: products, error, count } = productsResult;

  if (error) {
    return errorResponse(error.message, 500);
  }

  return jsonResponse({
    category: cleanCategory(category),
    items: (products ?? []).map((p: any) => cleanProduct(p, pricingConfig.exchangeRate, pricingConfig.markups.minorista, pricingConfig.embalageCost)),
    pagination: {
      total: count || 0,
      page,
      limit,
      total_pages: Math.ceil((count || 0) / limit)
    }
  }, 200, 60);
}
