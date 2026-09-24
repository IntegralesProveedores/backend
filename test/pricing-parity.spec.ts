import { describe, expect, it } from "vitest";
import { calculatePriceV2, embalajeShareForPack, round, TaxRule } from "../src/lib/pricing";
import { buildPricingConfigPayload, cleanProduct, resolveVolumeDiscountPercentage } from "../src/lib/products";
import type { PricingConfig, VolumeDiscountRule } from "../src/services/settings";
// El motor del frontend (el que usa el carrito en el navegador). Vive en el repo hermano
// `frontend/`: este test falla si los dos cálculos se separan.
import {
  calculateLocalPrice,
  cartVolumeDiscount,
  embalajePerPackArs,
  volumeDiscountFor
} from "../../frontend/src/app/core/lib/pricing.util";

// ─────────────────────────────────────────────────────────────
// QUÉ HACE: Compara el precio que calcula el frontend (pricing.util.ts) con el que cobra el
//           backend, sobre una grilla de productos, presentaciones, cantidades y configuraciones.
// POR QUÉ:  El carrito muestra el precio calculado en el navegador y el backend rechaza el pago
//           (409 price_changed) si no coincide: si alguien cambia un motor y no el otro, el
//           cliente no puede comprar. El frontend recibe la configuración de buildPricingConfigPayload,
//           así que se usa esa misma función para armarla (también cubre el contrato de la API).
// ─────────────────────────────────────────────────────────────

const IVA_NO_COMPUTABLE: TaxRule = { name: "IVA", percentage: 21, is_computable: false, is_active: true };
const IVA_COMPUTABLE: TaxRule = { name: "IVA", percentage: 21, is_computable: true, is_active: true };
const IIBB_INACTIVO: TaxRule = { name: "IIBB", percentage: 3.5, is_computable: true, is_active: false };

const DISCOUNTS: VolumeDiscountRule[] = [
  { min: 31, discount_percentage: 25 },
  { min: 21, discount_percentage: 20 },
  { min: 11, discount_percentage: 15 },
  { min: 6, discount_percentage: 10 },
  { min: 3, discount_percentage: 5 }
];

function backendConfig(overrides: Partial<PricingConfig> = {}): PricingConfig {
  return {
    exchangeRate: 1450.5,
    embalageCost: 760,
    packagingCost: 2000,
    markups: { minorista: 60, mayorista: 30, embalaje: 60 },
    shippingPriceBufferPercentage: 0,
    paymentCommissionPercentage: 10,
    ...overrides
  };
}

const CONFIGS: Array<{ name: string; config: PricingConfig; taxes: TaxRule[]; discounts: VolumeDiscountRule[] }> = [
  { name: "producción (IVA no computable, 10% MP)", config: backendConfig(), taxes: [IVA_NO_COMPUTABLE], discounts: DISCOUNTS },
  { name: "IVA computable + impuesto inactivo", config: backendConfig(), taxes: [IVA_COMPUTABLE, IIBB_INACTIVO], discounts: DISCOUNTS },
  { name: "sin comisión, otro dólar y markup", config: backendConfig({ paymentCommissionPercentage: 0, exchangeRate: 1000, markups: { minorista: 45.5, mayorista: 30, embalaje: 0 } }), taxes: [IVA_NO_COMPUTABLE], discounts: DISCOUNTS },
  { name: "tabla de descuentos vacía (backend usa la de fábrica)", config: backendConfig(), taxes: [IVA_NO_COMPUTABLE], discounts: [] }
];

const PRODUCTS = [
  { name: "semillera", cost: 19, currency: "USD" as const, master: 48, presentations: [48, 96, 480] },
  { name: "olivo", cost: 7.35, currency: "USD" as const, master: 25, presentations: [1, 24, 25] },
  { name: "almaciguera", cost: 123.456, currency: "USD" as const, master: 600, presentations: [50, 600] },
  { name: "costo en pesos", cost: 15000, currency: "ARS" as const, master: 100, presentations: [10, 100] }
];

const QUANTITIES = [1, 2, 3, 7, 13, 40];

function rawProduct(product: (typeof PRODUCTS)[number], hasPackaging: boolean) {
  return {
    id: `prod-${product.name}`,
    name: product.name,
    slug: product.name,
    cost_usd: product.cost,
    cost_currency: product.currency,
    units_per_pack_master: product.master,
    stock_units: 1_000_000,
    product_categories: [],
    product_images: [],
    product_variants: product.presentations.map(units => ({
      id: `var-${product.name}-${units}`,
      sku: `${product.name}-${units}`,
      units_per_pack: units,
      has_packaging: hasPackaging,
      is_active: true,
      deleted_at: null
    }))
  } as any;
}

describe("paridad de precios frontend ↔ backend", () => {
  for (const { name, config, taxes, discounts } of CONFIGS) {
    // Lo que recibe el navegador en `pricing_config`.
    const frontendConfig = JSON.parse(JSON.stringify(buildPricingConfigPayload(config, taxes, discounts)));

    it(`precio de la ficha (listado): ${name}`, () => {
      let compared = 0;
      for (const product of PRODUCTS) {
        for (const hasPackaging of [false, true]) {
          for (const quantity of QUANTITIES) {
            const clean = cleanProduct(
              rawProduct(product, hasPackaging),
              config.exchangeRate,
              config.markups.minorista,
              quantity,
              taxes,
              discounts,
              config.packagingCost,
              config.paymentCommissionPercentage
            );
            for (const variant of clean.variants) {
              const local = calculateLocalPrice(
                product.cost,
                product.master,
                variant.units_per_pack,
                quantity,
                product.currency,
                frontendConfig,
                hasPackaging
              );
              const label = `${product.name} x${variant.units_per_pack} cant ${quantity} packaging=${hasPackaging}`;
              expect(local.price_ars, label).toBe(variant.price_ars);
              expect(local.price_usd, label).toBe(variant.price_usd);
              compared++;
            }
          }
        }
      }
      expect(compared).toBeGreaterThan(100);
    });

    it(`precio de cada línea del carrito (descuento del carrito + embalaje): ${name}`, () => {
      for (const product of PRODUCTS) {
        for (const quantity of QUANTITIES) {
          for (const cartDiscount of [0, 5, 25]) {
            for (const presentation of product.presentations) {
              // Igual que buildOrderQuote: costo con el descuento del carrito y precio V2.
              const backend = calculatePriceV2({
                cost_usd_master: round(product.cost * (1 - cartDiscount / 100)),
                cost_currency: product.currency,
                units_per_pack_master: product.master,
                presentation_quantity: presentation,
                exchange_rate: config.exchangeRate,
                rentability_percentage: config.markups.minorista,
                taxes,
                packaging_cost: 0,
                payment_gross_up_percentage: config.paymentCommissionPercentage
              });
              const local = calculateLocalPrice(
                product.cost,
                product.master,
                presentation,
                quantity,
                product.currency,
                frontendConfig,
                false,
                cartDiscount
              );
              const label = `${product.name} x${presentation} cant ${quantity} desc ${cartDiscount}%`;
              expect(local.price_ars, label).toBe(Math.round(backend.precio_final_ars));
              expect(local.price_sin_impuestos_ars, label).toBe(backend.precio_sin_impuestos_ars);
            }
          }
        }
      }
    });

    it(`tramo de descuento por volumen: ${name}`, () => {
      for (const packs of [0, 0.5, 1, 2.99, 3, 5.9, 6, 10, 11, 20.5, 21, 30, 31, 500]) {
        expect(volumeDiscountFor(packs, frontendConfig), `${packs} packs`).toBe(
          resolveVolumeDiscountPercentage(packs, discounts)
        );
      }
    });
  }

  it("descuento del carrito: el mayor tramo de cualquier producto, igual en los dos lados", () => {
    const frontendConfig = buildPricingConfigPayload(backendConfig(), [IVA_NO_COMPUTABLE], DISCOUNTS);
    const carts = [
      [{ unitsPerPack: 48, quantity: 1, unitsPerPackMaster: 48 }],
      [{ unitsPerPack: 48, quantity: 3, unitsPerPackMaster: 48 }, { unitsPerPack: 25, quantity: 1, unitsPerPackMaster: 25 }],
      [{ unitsPerPack: 24, quantity: 13, unitsPerPackMaster: 25 }, { unitsPerPack: 600, quantity: 40, unitsPerPackMaster: 600 }]
    ];
    for (const lines of carts) {
      const backend = Math.max(0, ...lines.map(l => resolveVolumeDiscountPercentage((l.unitsPerPack * l.quantity) / l.unitsPerPackMaster, DISCOUNTS)));
      expect(cartVolumeDiscount(lines, frontendConfig)).toBe(backend);
    }
  });

  it("reparto del embalaje en cada presentación, igual en los dos lados", () => {
    for (const [embalaje, totalUnits, perPack] of [
      [1351, 48, 48], [2702, 1800, 600], [1351, 49, 24], [4053, 125, 25], [0, 10, 1], [1351, 0, 24], [1351, 7, 3]
    ]) {
      expect(embalajePerPackArs(embalaje, totalUnits, perPack)).toBe(embalajeShareForPack(embalaje, totalUnits, perPack));
    }
  });
});
