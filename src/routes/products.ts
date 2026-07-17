import { getSupabase } from "../services/db";
import { getPricingConfig } from "../services/settings";
import { jsonResponse, errorResponse } from "../lib/response";
import { PRODUCT_SUMMARY_SELECT, PRODUCT_DETAIL_SELECT, cleanProduct, DEFAULT_VOLUME_DISCOUNTS } from "../lib/products";
import { RouteContext } from "../lib/router";
import { RawProduct } from "../lib/types";

export async function handleProducts({ env, url }: RouteContext) {
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
      .order("name", { ascending: true })
      .range(offset, offset + limit - 1);

    const [pricingConfig, productsResult, taxesResult, discountsResult] = await Promise.all([
      getPricingConfig(env),
      productsQuery,
      supabase
        .from("pricing_taxes")
        .select("name, percentage, is_computable, is_active")
        .eq("is_active", true),
      supabase
        .from("pricing_volume_discounts")
        .select("min_quantity, factor")
        .order("min_quantity", { ascending: false })
    ]);

    const { data, error, count } = productsResult;
    if (error) {
      return errorResponse(error.message, 500);
    }

    const { data: dbTaxes } = taxesResult;
    const { data: dbDiscounts } = discountsResult;

    const taxes = (dbTaxes ?? []).map(t => ({
      name: t.name,
      percentage: Number(t.percentage),
      is_computable: t.is_computable,
      is_active: t.is_active
    }));

    const volumeDiscounts = (dbDiscounts ?? []).map(d => ({
      min: Number(d.min_quantity),
      factor: Number(d.factor)
    }));
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
        markup: pricingConfig.markups.minorista
      },
      pagination: {
        total: count || 0,
        page,
        limit,
        total_pages: Math.ceil((count || 0) / limit)
      }
    }, 200, 60);
  } catch (e: any) {
    return errorResponse(`handleProducts Error: ${e.message}`, 500, { stack: e.stack });
  }
}

export async function handleProductBySlug({ env, params, url }: RouteContext) {
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

    const [pricingConfig, productResult, taxesResult, discountsResult] = await Promise.all([
      getPricingConfig(env),
      productQuery,
      supabase
        .from("pricing_taxes")
        .select("name, percentage, is_computable, is_active")
        .eq("is_active", true),
      supabase
        .from("pricing_volume_discounts")
        .select("min_quantity, factor")
        .order("min_quantity", { ascending: false })
    ]);

    const { data, error } = productResult;

    if (error || !data) {
      return errorResponse("Product not found", 404);
    }

    const { data: dbTaxes } = taxesResult;
    const { data: dbDiscounts } = discountsResult;

    const taxes = (dbTaxes ?? []).map(t => ({
      name: t.name,
      percentage: Number(t.percentage),
      is_computable: t.is_computable,
      is_active: t.is_active
    }));

    const volumeDiscounts = (dbDiscounts ?? []).map(d => ({
      min: Number(d.min_quantity),
      factor: Number(d.factor)
    }));
    const resolvedVolumeDiscounts = volumeDiscounts.length > 0 ? volumeDiscounts : DEFAULT_VOLUME_DISCOUNTS;

    const product = data as unknown as RawProduct;

    return jsonResponse({
      ...(cleanProduct(product, pricingConfig.exchangeRate, pricingConfig.markups.minorista, pricingConfig.embalageCost, quantity, taxes, volumeDiscounts)),
      pricing_config: {
        exchange_rate: pricingConfig.exchangeRate,
        embalaje_cost: pricingConfig.embalageCost,
        taxes,
        volume_discounts: resolvedVolumeDiscounts,
        markup: pricingConfig.markups.minorista
      }
    });
  } catch (e: any) {
    return errorResponse(`handleProductBySlug Error: ${e.message}`, 500, { stack: e.stack });
  }
}
