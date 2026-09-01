import { RawProduct, CleanProduct, CleanVariant, RawCategory } from "./types";
import { calculatePriceV2, TaxRule, EMBALAJE_COST } from "./pricing";

export const DEFAULT_VOLUME_DISCOUNTS = [
  { min: 31, factor: 1.25 },
  { min: 21, factor: 1.20 },
  { min: 11, factor: 1.15 },
  { min: 6, factor: 1.10 },
  { min: 3, factor: 1.05 },
  { min: 1, factor: 1.00 }
];

export function resolveVolumeDiscountFactor(
  equivalentPacks: number,
  dbDiscounts: { min: number, factor: number }[] = []
): number {
  const discounts = dbDiscounts.length > 0 ? dbDiscounts : DEFAULT_VOLUME_DISCOUNTS;
  const sortedDiscounts = [...discounts].sort((a, b) => b.min - a.min);
  const discountEntry = sortedDiscounts.find(d => equivalentPacks >= d.min);
  return discountEntry ? discountEntry.factor : 1;
}

/** Proyección mínima para listados (Summary) - Evita overfetching (B4) */
export const PRODUCT_SUMMARY_SELECT = `
  id, name, slug, description, detail, active, cost_usd, cost_currency, units_per_pack_master, diameter_cm, height_cm, volume_cc, created_at,
  product_categories (
    categories (
      id, name, slug
    )
  ),
  product_variants (
    id, sku, stock, units_per_pack, is_active, deleted_at
  ),
  product_images (
    image_url, position
  )
`;

/** Proyección completa para detalle */
export const PRODUCT_DETAIL_SELECT = `
  id, name, slug, description, detail, active, cost_usd, cost_currency, units_per_pack_master, diameter_cm, height_cm, volume_cc, created_at, updated_at,
  product_categories (
    categories (
      id, name, slug, parent_id
    )
  ),
  product_variants (
    id, sku, stock, units_per_pack, is_active, deleted_at
  ),
  product_images (
    id, image_url, position
  )
`;

export function cleanProduct(
  product: RawProduct,
  exchangeRate: number = 1,
  markupMinorista: number,
  embalageCost: number = EMBALAJE_COST,
  quantity: number = 1,
  dbTaxes: TaxRule[] = [],
  dbDiscounts: { min: number, factor: number }[] = []
): CleanProduct {
  if (!product) throw new Error("cleanProduct: product is undefined");
  if (!Number.isFinite(markupMinorista)) throw new Error("cleanProduct: markupMinorista is invalid");

  const taxes = dbTaxes;
  const discounts = dbDiscounts.length > 0 ? dbDiscounts : DEFAULT_VOLUME_DISCOUNTS;

  const cats = (product.product_categories ?? [])
    .map(pc => pc.categories)
    .filter((c): c is RawCategory => c !== null);

  const cost_usd_master = Number(product.cost_usd) || 0;
  const units_per_pack_master = Number(product.units_per_pack_master) || 1;

  const variants = (product.product_variants ?? [])
    .filter(v => v.is_active && v.deleted_at === null)
    .map(v => {
      const presentation_quantity = Number(v.units_per_pack) || 1;

      const equivalentPacks = (presentation_quantity * quantity) / units_per_pack_master;
      const discountFactor = resolveVolumeDiscountFactor(equivalentPacks, discounts);

      const costUsdMasterWithDiscount = Math.round((cost_usd_master / discountFactor + Number.EPSILON) * 100) / 100;
      const markup_val = Number(markupMinorista) || 0;

      const v2Result = calculatePriceV2({
        cost_usd_master: costUsdMasterWithDiscount,
        cost_currency: product.cost_currency,
        units_per_pack_master,
        presentation_quantity,
        exchange_rate: exchangeRate,
        rentability_percentage: markup_val,
        taxes: taxes,
        embalaje_cost: embalageCost
      });

      const stockUnits = Number(v.stock) || 0;

      const ivaRule = taxes.find(t => t.name.toUpperCase() === 'IVA' && t.is_active);
      const vat_included = ivaRule ? ivaRule.is_computable : false;
      const vat_label = vat_included ? 'IVA Incluido' : 'IVA no incluido';

      const price_ars_val = Math.round(v2Result.precio_final_ars);
      const price_usd_val = Math.round((price_ars_val / exchangeRate + Number.EPSILON) * 100) / 100;

      const variant: CleanVariant = {
        id: v.id,
        cost_usd: costUsdMasterWithDiscount,
        cost_currency: product.cost_currency,
        price_usd: price_usd_val,
        price_ars: price_ars_val,
        markup_percentage: markup_val,
        stock: stockUnits,
        sku: v.sku,
        units_per_pack: presentation_quantity,
        vat_included,
        vat_label
      };

      variant.dimensions = {
        volume_cc: v.volume_cc || null,
        length_cm: v.length_cm || null,
        width_cm: v.width_cm || null,
        height_cm: v.height_cm || null,
        diameter_cm: v.diameter_cm || null
      };

      if (v.weight_grams) variant.weight_grams = v.weight_grams;

      return variant;
    });

  return {
    id: product.id,
    name: product.name,
    slug: product.slug,
    description: product.description,
    detail: product.detail ?? null,
    active: product.active,
    cost_usd: Number(product.cost_usd) || 0,
    units_per_pack_master: Number(product.units_per_pack_master) || null,
    diameter_cm: product.diameter_cm ?? null,
    height_cm: product.height_cm ?? null,
    volume_cc: product.volume_cc ?? null,
    category: cats[0] ?? null,
    categories: cats,
    variants,
    images: (product.product_images ?? [])
      .sort((a, b) => a.position - b.position)
      .map(img => ({
        id: img.id,
        url: img.image_url,
        position: img.position
      }))
  };
}
