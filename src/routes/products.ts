import { getSupabase } from "../services/db";
import { getPricingConfig, getCachedTaxes, getCachedVolumeDiscounts } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, PRODUCT_DETAIL_SELECT, cleanProduct, DEFAULT_VOLUME_DISCOUNTS } from "../lib/products";
import { RouteContext } from "../lib/router";
import { RawProduct } from "../lib/types";
import { enforceRateLimit } from "../lib/rate-limit";

export async function handleProducts({ env, url, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "products/list");
  if (limited) return limited;

  try {
    const supabase = getSupabase(env);

    const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
    const offset = (page - 1) * limit;
    const quantity = Math.max(1, parseInt(url.searchParams.get("quantity") || "1"));

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

    const resolvedVolumeDiscounts = volumeDiscounts.length > 0 ? volumeDiscounts : DEFAULT_VOLUME_DISCOUNTS;

    const products = (data ?? []) as unknown as RawProduct[];

    return jsonResponse({
      items: products.map(p =>
        cleanProduct(p, pricingConfig.exchangeRate, pricingConfig.markups.minorista, pricingConfig.embalageCost, quantity, taxes, volumeDiscounts)
      ),
      pricing_config: {
        exchange_rate: pricingConfig.exchangeRate,
        embalaje_cost: pricingConfig.embalageCost,
        taxes,
        volume_discounts: resolvedVolumeDiscounts,
        markup: pricingConfig.markups.minorista,
        payment_commission_percentage: pricingConfig.paymentCommissionPercentage
      },
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

    const quantity = Math.max(1, parseInt(url.searchParams.get("quantity") || "1"));
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

    const resolvedVolumeDiscounts = volumeDiscounts.length > 0 ? volumeDiscounts : DEFAULT_VOLUME_DISCOUNTS;

    const product = data as unknown as RawProduct;
    const cleaned = cleanProduct(product, pricingConfig.exchangeRate, pricingConfig.markups.minorista, pricingConfig.embalageCost, quantity, taxes, volumeDiscounts);

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
      pricing_config: {
        exchange_rate: pricingConfig.exchangeRate,
        embalaje_cost: pricingConfig.embalageCost,
        taxes,
        volume_discounts: resolvedVolumeDiscounts,
        markup: pricingConfig.markups.minorista,
        payment_commission_percentage: pricingConfig.paymentCommissionPercentage
      }
    });
  } catch (e: any) {
    return errorResponse("Unable to load product", 500, { original_message: e.message, stack: e.stack });
  }
}
