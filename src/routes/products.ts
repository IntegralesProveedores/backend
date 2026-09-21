import { getSupabase } from "../services/db";
import { getPricingConfig, getCachedTaxes, getCachedVolumeDiscounts } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, PRODUCT_DETAIL_SELECT, cleanProduct, buildPricingConfigPayload } from "../lib/products";
import { RouteContext } from "../lib/router";
import { RawProduct } from "../lib/types";
import { enforceRateLimit } from "../lib/rate-limit";
import { parseIntParam } from "../lib/request";

export async function handleProducts({ env, url, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "products/list");
  if (limited) return limited;

  try {
    const supabase = getSupabase(env);

    const page = parseIntParam(url.searchParams.get("page"), 1, 1);
    const limit = parseIntParam(url.searchParams.get("limit"), 20, 1, 50);
    const offset = (page - 1) * limit;
    const quantity = parseIntParam(url.searchParams.get("quantity"), 1, 1);

    const productsQuery = supabase
      .from("products")
      .select(PRODUCT_SUMMARY_SELECT, { count: "exact" })
      .eq("active", true)
      .is("deleted_at", null)
      .order("volume_cc", { ascending: true })
      .range(offset, offset + limit - 1);

    const [pricingConfig, productsResult, taxes, volumeDiscounts] = await Promise.all([
      getPricingConfig(env),
      productsQuery,
      getCachedTaxes(env),
      getCachedVolumeDiscounts(env)
    ]);

    const { data, error, count } = productsResult;
    if (error) {
      return errorResponse("Unable to load products", 500, { supabase_error: error.message });
    }

    const products = (data ?? []) as unknown as RawProduct[];

    return jsonResponse({
      items: products.map(p =>
        cleanProduct(p, pricingConfig.exchangeRate, pricingConfig.markups.minorista, quantity, taxes, volumeDiscounts, pricingConfig.packagingCost ?? 0, pricingConfig.paymentCommissionPercentage)
      ),
      pricing_config: buildPricingConfigPayload(pricingConfig, taxes, volumeDiscounts),
      pagination: {
        total: count || 0,
        page,
        limit,
        total_pages: Math.ceil((count || 0) / limit)
      }
    }, 200, 60);
  } catch (e: any) {
    return errorResponse("Unable to load products", 500, { original_message: e.message, stack: e.stack });
  }
}

export async function handleProductBySlug({ env, params, url, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "products/get");
  if (limited) return limited;

  try {
    const { slug } = params;
    if (!slug || slug.length > 200 || !/^[a-z0-9-]+$/.test(slug)) {
      return errorResponse("Invalid slug format", 400);
    }

    const quantity = parseIntParam(url.searchParams.get("quantity"), 1, 1);
    const supabase = getSupabase(env);
    const productQuery = supabase
      .from("products")
      .select(PRODUCT_DETAIL_SELECT)
      .eq("slug", slug)
      .eq("active", true)
      .is("deleted_at", null)
      .single();

    const [pricingConfig, productResult, taxes, volumeDiscounts] = await Promise.all([
      getPricingConfig(env),
      productQuery,
      getCachedTaxes(env),
      getCachedVolumeDiscounts(env)
    ]);

    const { data, error } = productResult;

    if (error || !data) {
      return errorResponse("Product not found", 404);
    }

    const product = data as unknown as RawProduct;
    const cleaned = cleanProduct(product, pricingConfig.exchangeRate, pricingConfig.markups.minorista, quantity, taxes, volumeDiscounts, pricingConfig.packagingCost ?? 0, pricingConfig.paymentCommissionPercentage);

    // El breadcrumb necesita la categoría padre (ej. Agroindustrial > Macetas
    // Biodegradables); se resuelve en una query aparte en vez de un embed
    // self-referencing de Supabase porque PostgREST no puede desambiguar la
    // dirección del embed cuando "categories" se referencia a sí misma
    // dentro de un select ya anidado (products -> product_categories -> categories).
    if (cleaned.category?.parent_id) {
      const { data: parent } = await supabase
        .from("categories")
        .select("id, name, slug")
        .eq("id", cleaned.category.parent_id)
        .maybeSingle();
      if (parent) cleaned.category.parent = parent;
    }

    return jsonResponse({
      ...cleaned,
      pricing_config: buildPricingConfigPayload(pricingConfig, taxes, volumeDiscounts)
    });
  } catch (e: any) {
    return errorResponse("Unable to load product", 500, { original_message: e.message, stack: e.stack });
  }
}
