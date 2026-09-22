import { getSupabase } from "./db";
import { getPaymentCommissionPercentage, getShippingPriceBufferPercentage } from "./settings";
import { paymentGrossUpFactor } from "../lib/pricing";

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
}

/** Caja del embalaje/envío de un pedido: cuántas de cada modelo hacen falta. */
export interface PackagingBox {
  boxModelId: string;
  boxModelName: string;
  widthCm: number;
  lengthCm: number;
  heightCm: number;
  weightKg: number;
  count: number;
}

interface BoxCandidate {
  boxModelId: string;
  minQuantity: number;
  maxQuantity: number;
}

/**
 * Cuántas cajas de cada modelo hacen falta para `units` unidades de un mismo modelo de maceta:
 * si las unidades entran en el rango de una caja se usa esa; si exceden la caja más grande, se
 * llenan cajas grandes hasta que el resto entre en un rango.
 */
function pickBoxCounts(boxes: BoxCandidate[], units: number): Map<string, number> {
  const largestBox = boxes.reduce((largest, box) => box.maxQuantity > largest.maxQuantity ? box : largest);
  const counts = new Map<string, number>();
  let remainingUnits = units;
  while (remainingUnits > 0) {
    const matchingBox = boxes.find(box => remainingUnits >= box.minQuantity && remainingUnits <= box.maxQuantity);
    const box = matchingBox ?? (remainingUnits > largestBox.maxQuantity ? largestBox : null);
    if (!box) throw new Error(`Unable to build a shipping box plan for ${units} units`);
    counts.set(box.boxModelId, (counts.get(box.boxModelId) ?? 0) + 1);
    remainingUnits = matchingBox ? 0 : remainingUnits - largestBox.maxQuantity;
  }
  return counts;
}

/** Plan de embalaje de un pedido: las cajas (para mostrar) y cuántas le corresponden a cada
 *  producto (para repartir el costo del embalaje en el precio de cada producto). */
export interface PackagingPlan {
  boxes: PackagingBox[];
  /** product_id -> cantidad de cajas que le corresponden a ese producto. */
  perProductBoxCount: Map<string, number>;
}

/**
 * Cajas del pedido, independientes del envío (no depende del código postal ni de tarifas): una
 * o más cajas por modelo de maceta según sus unidades totales. Sirve para cobrar el embalaje
 * también con Retiro y Coordinar. Usa 2 consultas sin importar cuántos productos haya.
 */
export async function resolvePackagingPlan(env: Env, productGroups: ProductGroup[]): Promise<PackagingPlan> {
  const groups = productGroups.filter(group => group.units > 0);
  if (groups.length === 0) return { boxes: [], perProductBoxCount: new Map() };

  const supabase = getSupabase(env);
  const { data: assignments, error: assignmentsError } = await supabase
    .from("pricing_shipping_box_assignments")
    .select("product_id, box_model_id, min_quantity, max_quantity")
    .in("product_id", groups.map(group => group.product_id))
    .eq("active", true);
  if (assignmentsError) throw new Error(`Unable to load box rules: ${assignmentsError.message}`);

  const modelIds = [...new Set((assignments ?? []).map((a: any) => String(a.box_model_id)))];
  const modelsResult = modelIds.length
    ? await supabase.from("pricing_shipping_box_models")
        .select("id, name, width_cm, length_cm, height_cm, weight_kg")
        .eq("active", true).in("id", modelIds)
    : { data: [], error: null };
  if (modelsResult.error) throw new Error(`Unable to load box models: ${modelsResult.error.message}`);
  const models = new Map((modelsResult.data ?? []).map((m: any) => [String(m.id), m]));

  const result: PackagingBox[] = [];
  const perProductBoxCount = new Map<string, number>();
  for (const group of groups) {
    const boxes = (assignments ?? [])
      .filter((a: any) => String(a.product_id) === group.product_id)
      .flatMap((a: any) => {
        const model = models.get(String(a.box_model_id));
        const minQuantity = Number(a.min_quantity);
        const maxQuantity = Number(a.max_quantity);
        return model && Number.isFinite(minQuantity) && Number.isFinite(maxQuantity) && maxQuantity > 0
          ? [{ boxModelId: String(a.box_model_id), minQuantity, maxQuantity, model }]
          : [];
      });
    if (!boxes.length) throw new Error(`No shipping box rules found for product ${group.product_id}`);

    const counts = pickBoxCounts(boxes, group.units);
    let groupBoxCount = 0;
    for (const box of boxes) {
      const count = counts.get(box.boxModelId);
      if (!count) continue;
      groupBoxCount += count;
      const existing = result.find(b => b.boxModelId === box.boxModelId);
      if (existing) existing.count += count;
      else result.push({
        boxModelId: box.boxModelId,
        boxModelName: String(box.model.name),
        widthCm: Number(box.model.width_cm),
        lengthCm: Number(box.model.length_cm),
        heightCm: Number(box.model.height_cm),
        weightKg: Number(box.model.weight_kg),
        count
      });
    }
    perProductBoxCount.set(group.product_id, groupBoxCount);
  }
  return { boxes: result, perProductBoxCount };
}

export async function resolveShippingBoxPlan(
  env: Env,
  zoneName: string,
  productGroups: ProductGroup[],
  deliverySpeed = "standard"
): Promise<{ boxes: ShippingBox[]; totalPriceArs: number }> {
  if (productGroups.length === 0) return { boxes: [], totalPriceArs: 0 };

  const supabase = getSupabase(env);
  const shippingPriceBufferPercentage = await getShippingPriceBufferPercentage(env);
  // El envío también lleva el costo del medio de pago (ver paymentGrossUpFactor).
  const bufferFactor = (1 + shippingPriceBufferPercentage / 100) * paymentGrossUpFactor(await getPaymentCommissionPercentage(env));
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
      const capacity = Number(assignment.max_quantity);
      const price = rates.get(id);
      return model && Number.isFinite(minQuantity) && Number.isFinite(capacity) && capacity > 0 && price !== undefined
        ? [{ boxModelId: id, minQuantity, maxQuantity: capacity, capacity, priceArs: Math.round(price * bufferFactor), name: String(model.name), widthCm: Number(model.width_cm), lengthCm: Number(model.length_cm), heightCm: Number(model.height_cm), weightKg: Number(model.weight_kg) }]
        : [];
    });
    if (!boxes.length) throw new Error(`No active shipping rates found for zone "${zoneName}" and delivery speed "${deliverySpeed}"`);
    const counts = pickBoxCounts(boxes, group.units);
    let totalPrice = 0;
    for (const box of boxes) {
      const count = counts.get(box.boxModelId);
      if (!count) continue;
      totalPrice += count * box.priceArs;
      const existing = result.boxes.find(b => b.boxModelId === box.boxModelId);
      if (existing) existing.count += count;
      else result.boxes.push({ boxModelId: box.boxModelId, boxModelName: box.name, widthCm: box.widthCm, lengthCm: box.lengthCm, heightCm: box.heightCm, weightKg: box.weightKg, count, unitPriceArs: box.priceArs });
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

const normalizeProvince = (value: string): string =>
  value.normalize("NFD").replace(/[̀-ͯ]/g, "").trim().toLowerCase();

/**
 * Elige la provincia de un código postal. Hay códigos de 4 dígitos que
 * pertenecen a más de una provincia (ej. 2400: Córdoba y Santa Fe) y la zona
 * de envío sale de la provincia, así que la elección tiene que ser
 * determinística y coincidir con la que ve el cliente (GET /postal-code/:cp,
 * que usa el mismo orden). Si el cliente ya tiene una provincia cargada y es
 * una de las del código, se respeta; si no, la primera de la lista ordenada.
 */
export function pickPostalCodeProvince(
  rows: Array<{ province: string | null }>,
  preferredProvince?: string | null
): string | null {
  const provinces = rows.map(row => row.province).filter((province): province is string => !!province);
  if (preferredProvince) {
    const wanted = normalizeProvince(preferredProvince);
    const match = provinces.find(province => normalizeProvince(province) === wanted);
    if (match) return match;
  }
  return provinces[0] ?? null;
}

export async function resolveShippingRate(
  env: Env,
  postalCode: string,
  productGroups: ProductGroup[],
  preferredProvince?: string | null
): Promise<ShippingResolution | null> {
  const supabase = getSupabase(env);
  const normalizedPostalCode = extractPostalCodeDigits(postalCode);
  if (!normalizedPostalCode) return null;

  // 1) Fuente de verdad: buscar la provincia real por código postal exacto
  const { data: postalRows, error: postalError } = await supabase
    .from("postal_codes_ar")
    .select("province")
    .eq("postal_code", normalizedPostalCode)
    .order("created_at", { ascending: true })
    .order("province", { ascending: true })
    .order("id", { ascending: true });

  if (postalError) throw new Error(`Unable to resolve province for postal code: ${postalError.message}`);

  let zoneName = pickPostalCodeProvince(postalRows ?? [], preferredProvince);

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
    boxes: boxPlan.boxes
  };
}
