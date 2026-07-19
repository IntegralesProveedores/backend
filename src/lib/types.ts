// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Definiciones de tipos para el dominio de productos y variantes.
// POR QUÉ:  Elimina el uso de 'any' y garantiza consistencia de datos (B6).
// CUIDADO:  Debe mantenerse sincronizado con el schema de Supabase.
// ─────────────────────────────────────────────────────────────

export interface RawVariant {
  id: string;
  sku: string;
  stock: number;
  units_per_pack: number | null;
  volume_cc: number | null;
  weight_grams?: number | null;
  length_cm?: number | null;
  width_cm?: number | null;
  height_cm?: number | null;
  diameter_cm?: number | null;
  is_active: boolean;
  deleted_at: string | null;
}

export interface RawCategory {
  id: string;
  name: string;
  slug: string;
  parent_id?: string | null;
}

export interface RawProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  detail: string | null;
  active: boolean;
  cost_usd: number;
  units_per_pack_master: number;
  diameter_cm?: number | null;
  height_cm?: number | null;
  volume_cc?: number | null;
  created_at: string;
  updated_at?: string;
  product_categories: { categories: RawCategory | null }[];
  product_variants: RawVariant[];
  product_images: { id?: string; image_url: string; position: number }[];
}

export interface CleanVariant {
  id: string;
  sku: string;
  cost_usd: number;
  price_usd: number;
  price_ars: number;
  markup_percentage: number;
  stock: number;
  units_per_pack: number;
  vat_included: boolean;
  vat_label: string;
  weight_grams?: number;
  dimensions?: {
    volume_cc: number | null;
    length_cm: number | null;
    width_cm: number | null;
    height_cm: number | null;
    diameter_cm: number | null;
  };
}

export interface CleanProduct {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  detail?: string | null;
  active: boolean;
  category: RawCategory | null;
  categories: RawCategory[];
  variants: CleanVariant[];
  images: { id?: string; url: string; position: number }[];
  cost_usd?: number;
  units_per_pack_master?: number | null;
  diameter_cm?: number | null;
  height_cm?: number | null;
  volume_cc?: number | null;
}
