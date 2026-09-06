import { getSupabase } from "./db";
import { getPricingConfig } from "./settings";
import { ShippingInput } from "../lib/payment-input.validation";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Resolución de zona/tarifa/plan de cajas de envío.
// POR QUÉ:  Antes vivía mezclado dentro de payment.service.ts junto
//           con persistencia de órdenes, email y checkout de MP.
// ─────────────────────────────────────────────────────────────

export interface ShippingBox {
  boxModelId: string;
  boxModelName: string;
  widthCm: number;
  lengthCm: number;
  heightCm: number;
  weightKg: number;
  count: number;
  unitPriceArs: number;
}

export interface ProductGroup {
  product_id: string;
  units: number;
}

interface ShippingResolution {
  zone: string;
  priceArs: number;
  boxes: ShippingBox[];
  boxCount: number;
}

export async function resolveShippingBoxPlan(
  env: Env,
  zoneName: string,
  productGroups: ProductGroup[],
  deliverySpeed = "standard"
): Promise<{ boxes: ShippingBox[]; totalPriceArs: number }> {
  if (productGroups.length === 0) return { boxes: [], totalPriceArs: 0 };

  const supabase = getSupabase(env);
  const { shippingPriceBufferPercentage } = await getPricingConfig(env);
  const bufferFactor = 1 + shippingPriceBufferPercentage / 100;
  const result = { boxes: [] as ShippingBox[], totalPriceArs: 0 };
  for (const group of productGroups) {
    if (group.units <= 0) continue;
    const { data: assignments, error: assignmentsError } = await supabase
      .from("pricing_shipping_box_assignments")
      .select("box_model_id, min_quantity, max_quantity")
      .eq("product_id", group.product_id)
      .eq("active", true);
    if (assignmentsError) throw new Error(`Unable to load shipping box rules: ${assignmentsError.message}`);
    if (!assignments?.length) throw new Error(`No shipping box rules found for product ${group.product_id}`);

    const modelIds = [...new Set(assignments.map((a: any) => String(a.box_model_id)))];
    const [ratesResult, modelsResult] = await Promise.all([
      supabase.from("pricing_shipping_rates").select("price_ars, box_model_id")
        .eq("zone_name", zoneName).eq("delivery_speed", deliverySpeed).eq("active", true)
        .in("box_model_id", modelIds),
      supabase.from("pricing_shipping_box_models").select("id, name, width_cm, length_cm, height_cm, weight_kg")
        .eq("active", true).in("id", modelIds)
    ]);
    if (ratesResult.error || modelsResult.error) {
      throw new Error(`Unable to load shipping boxes and rates: ${ratesResult.error?.message ?? modelsResult.error?.message}`);
    }
    const rates = new Map((ratesResult.data ?? []).map((r: any) => [String(r.box_model_id), Number(r.price_ars)]));
    const models = new Map((modelsResult.data ?? []).map((m: any) => [String(m.id), m]));
    const boxes = assignments.flatMap((assignment: any) => {
      const id = String(assignment.box_model_id);
      const model = models.get(id);
      const minQuantity = Number(assignment.min_quantity);
      const maxQuantity = Number(assignment.max_quantity);
      const capacity = Number(assignment.max_quantity);
      const price = rates.get(id);
      return model && Number.isFinite(minQuantity) && Number.isFinite(capacity) && capacity > 0 && price !== undefined
        ? [{ boxModelId: id, minQuantity, maxQuantity: capacity, capacity, priceArs: Math.round(price * bufferFactor), name: String(model.name), widthCm: Number(model.width_cm), lengthCm: Number(model.length_cm), heightCm: Number(model.height_cm), weightKg: Number(model.weight_kg) }]
        : [];
    });
    if (!boxes.length) throw new Error(`No active shipping rates found for zone "${zoneName}" and delivery speed "${deliverySpeed}"`);
    const largestBox = boxes.reduce((largest, box) => box.maxQuantity > largest.maxQuantity ? box : largest);
    const counts = new Map<string, number>();
    let remainingUnits = group.units;
    let totalPrice = 0;
    while (remainingUnits > 0) {
      const matchingBox = boxes.find(box => remainingUnits >= box.minQuantity && remainingUnits <= box.maxQuantity);
      const box = matchingBox ?? (remainingUnits > largestBox.maxQuantity ? largestBox : null);
      if (!box) throw new Error(`Unable to build a shipping box plan for ${group.units} units`);
      counts.set(box.boxModelId, (counts.get(box.boxModelId) ?? 0) + 1);
      totalPrice += box.priceArs;
      remainingUnits = matchingBox ? 0 : remainingUnits - largestBox.maxQuantity;
    }
    for (const box of boxes) if (counts.has(box.boxModelId)) {
      const existing = result.boxes.find(b => b.boxModelId === box.boxModelId);
      if (existing) existing.count += counts.get(box.boxModelId)!;
      else result.boxes.push({ boxModelId: box.boxModelId, boxModelName: box.name, widthCm: box.widthCm, lengthCm: box.lengthCm, heightCm: box.heightCm, weightKg: box.weightKg, count: counts.get(box.boxModelId)!, unitPriceArs: box.priceArs });
    }
    result.totalPriceArs += Math.round(totalPrice);
  }
  return result;
}

/** Extrae los 4 dígitos numéricos de un código postal, sea formato viejo (1428)
 *  o CPA completo (C1428BOB). Devuelve null si no encuentra 4 dígitos válidos. */
function extractPostalCodeDigits(rawPostalCode: string): string | null {
  const digits = (rawPostalCode ?? "").replace(/\D/g, "").slice(0, 4);
  return /^\d{4}$/.test(digits) ? digits : null;
}

export async function resolveShippingRate(
  env: Env,
  postalCode: string,
  productGroups: ProductGroup[]
): Promise<ShippingResolution | null> {
  const supabase = getSupabase(env);
  const normalizedPostalCode = extractPostalCodeDigits(postalCode);
  if (!normalizedPostalCode) return null;

  // 1) Fuente de verdad: buscar la provincia real por código postal exacto
  const { data: postalData, error: postalError } = await supabase
    .from("postal_codes_ar")
    .select("province")
    .eq("postal_code", normalizedPostalCode)
    .limit(1)
    .maybeSingle();

  if (postalError) throw new Error(`Unable to resolve province for postal code: ${postalError.message}`);

  let zoneName = postalData?.province ?? null;

  // 2) Fallback: si el código postal no está cargado en postal_codes_ar,
  //    usamos el esquema anterior por rango (CABA_PBA / RESTO_PAIS) para no romper el checkout.
  if (!zoneName) {
    const cp = Number.parseInt(normalizedPostalCode, 10);
    const { data: zoneData, error: zoneError } = await supabase
      .from("pricing_shipping_zones")
      .select("zone_name")
      .eq("active", true)
      .lte("postal_code_from", cp)
      .gte("postal_code_to", cp)
      .limit(1)
      .maybeSingle();

    if (zoneError) throw new Error(`Unable to resolve shipping zone: ${zoneError.message}`);
    zoneName = zoneData?.zone_name ?? null;
  }

  if (!zoneName) return null;

  const boxPlan = await resolveShippingBoxPlan(env, String(zoneName), productGroups);

  return {
    zone: String(zoneName),
    priceArs: boxPlan.totalPriceArs,
    boxes: boxPlan.boxes,
    boxCount: boxPlan.boxes.reduce((sum, box) => sum + box.count, 0)
  };
}

export async function getShippingPriceArs(
  env: Env,
  shipping: ShippingInput,
  productGroups: ProductGroup[]
): Promise<number> {
  if (shipping.method === "pickup" || shipping.method === "coordinar") return 0;
  if (!shipping.address?.postal_code) return 0;
  const resolution = await resolveShippingRate(env, shipping.address.postal_code, productGroups);
  return resolution?.priceArs ?? 0;
}
