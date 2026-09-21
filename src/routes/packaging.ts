import { jsonResponse, errorResponse } from "../lib/response";
import { RouteContext } from "../lib/router";
import { resolvePackagingPlan } from "../services/shipping.service";
import { getPricingConfig } from "../services/settings";
import { embalajeBoxPriceArs } from "../lib/pricing";
import { enforceRateLimit } from "../lib/rate-limit";
import { readJsonBody } from "../lib/request";
import { parseProductGroups } from "../lib/product-groups";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Cotiza el embalaje de un carrito: cuántas cajas de cada modelo hacen falta
//           y cuánto cuestan. No depende del método de entrega ni del código postal.
// POR QUÉ:  El embalaje se cobra por caja (una o más por modelo de maceta), incluso con
//           Retiro o Coordinar; la pantalla necesita mostrarlo antes de elegir el envío.
// ─────────────────────────────────────────────────────────────

export async function handlePackagingQuote({ env, request }: RouteContext) {
  const limited = await enforceRateLimit(env, request, "packaging/quote");
  if (limited) return limited;

  const rawBody = await readJsonBody(request);
  if (!rawBody || typeof rawBody !== "object") return errorResponse("Invalid JSON body", 400);
  const parsed = parseProductGroups((rawBody as { items?: unknown }).items);
  if ("error" in parsed) return errorResponse(parsed.error, 400);

  try {
    const [pricingConfig, boxes] = await Promise.all([
      getPricingConfig(env),
      resolvePackagingPlan(env, parsed.groups)
    ]);
    const boxPriceArs = embalajeBoxPriceArs(
      pricingConfig.embalageCost,
      pricingConfig.markups.embalaje,
      pricingConfig.paymentCommissionPercentage
    );
    const boxCount = boxes.reduce((sum, box) => sum + box.count, 0);

    return jsonResponse({
      boxes,
      box_count: boxCount,
      embalaje_box_price_ars: boxPriceArs,
      embalaje_ars: boxCount * boxPriceArs
    });
  } catch (e: any) {
    return errorResponse("Unable to quote packaging", 500, { original_message: e.message, stack: e.stack });
  }
}
