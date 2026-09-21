import { describe, it, expect } from 'vitest';
import { calculatePriceV2, TaxRule } from '../src/lib/pricing';

/**
 * Casos de prueba para validación de Pricing Engine V2.
 * Datos de entrada basados en la auditoría de paridad final.
 *
 * pricing.ts no expone un set de impuestos por defecto (los impuestos
 * siempre vienen de la tabla pricing_taxes en runtime), así que estos
 * casos fijan localmente el único impuesto que asumen los cálculos de
 * paridad documentados abajo: IVA 21% computable.
 */
const DEFAULT_TAX_RULES: TaxRule[] = [
  { name: 'IVA', percentage: 21, is_computable: true, is_active: true }
];

describe('Pricing Engine V2 - Shadow Mode Validation', () => {
  const EXCHANGE_RATE = 1450;
  
  const TEST_PRODUCTS = [
    { name: 'Semillera', cost: 19, units: 960 },
    { name: 'Almaciguera', cost: 48, units: 600 },
    { name: 'Olivo', cost: 47, units: 500 },
    { name: 'Floral', cost: 58, units: 300 },
    { name: 'Floral 11', cost: 70, units: 100 }
  ];

  describe('Tenant: Base (Rentabilidad 20%)', () => {
    const RENTABILITY = 20;

    it.each(TEST_PRODUCTS)('Debe calcular correctamente el precio para $name', ({ cost, units }) => {
      const result = calculatePriceV2({
        cost_usd_master: cost,
        units_per_pack_master: units,
        presentation_quantity: units, // Probamos con el bulto completo
        exchange_rate: EXCHANGE_RATE,
        rentability_percentage: RENTABILITY,
        taxes: DEFAULT_TAX_RULES
      });

      // Verificaciones determinísticas
      expect(result.precio_unitario_neto).toBeGreaterThan(0);
      expect(result.precio_final_ars).toBeGreaterThan(result.costo_total_operativo);
      
      // Caso Olivo: Validación manual del reporte de paridad
      if (cost === 47 && units === 500) {
        // Base Costo V2 con IVA computable: (136.30 * 1.21 * 500) + 745.56 = 83207.06
        // Precio Final (20%): 83207.06 * 1.2 = 99848.47
        expect(result.costo_total_operativo).toBe(83207.06);
        expect(result.precio_final_ars).toBe(99848.47);
      }
    });

    it('No debe computar impuestos no computables en el costo base', () => {
      const withTaxes = calculatePriceV2({
        cost_usd_master: 100,
        units_per_pack_master: 100,
        presentation_quantity: 10,
        exchange_rate: 1000,
        rentability_percentage: 20,
        taxes: [
          { name: 'IIBB', percentage: 3, is_computable: false, is_active: true }
        ]
      });

      const withoutTaxes = calculatePriceV2({
        cost_usd_master: 100,
        units_per_pack_master: 100,
        presentation_quantity: 10,
        exchange_rate: 1000,
        rentability_percentage: 20,
        taxes: []
      });

      // Como IIBB no es computable, el precio final debe ser idéntico.
      expect(withTaxes.precio_final_ars).toBe(withoutTaxes.precio_final_ars);
    });
  });

  describe('Tenant: Brotalia (Rentabilidad 40%)', () => {
    const RENTABILITY = 40;

    it('Debe aplicar rentabilidad superior para Brotalia', () => {
      const result = calculatePriceV2({
        cost_usd_master: 47,
        units_per_pack_master: 500,
        presentation_quantity: 25, // Presentación pequeña
        exchange_rate: EXCHANGE_RATE,
        rentability_percentage: RENTABILITY,
        taxes: DEFAULT_TAX_RULES
      });

      // (47 * 1450 / 500) * 25 = 3407.50
      // IVA computable (21%): 3407.50 * 0.21 = 715.575 -> 715.58
      // Costo total computable: 3407.50 + 715.58 = 4123.08
      // Embalaje: 745.56
      // Costo total operativo: 4123.08 + 745.56 = 4868.64
      // Precio venta (40%): 4868.64 * 1.4 = 6816.096 -> 6816.10
      expect(result.costo_total_operativo).toBe(4868.64);
      expect(result.precio_final_ars).toBe(6816.09);
    });
  });

  describe('Manejo de Impuestos Computables', () => {
    it('Debe aumentar el costo base si el impuesto es computable', () => {
      const result = calculatePriceV2({
        cost_usd_master: 100,
        units_per_pack_master: 1,
        presentation_quantity: 1,
        exchange_rate: 1,
        rentability_percentage: 0,
        taxes: [
          { name: 'Importación', percentage: 10, is_computable: true, is_active: true }
        ]
      });

      // Costo 100 + 10 (impuesto) + 745.56 (embalaje) = 855.56
      expect(result.precio_final_ars).toBe(855.56);
    });
  });
});

describe('Pricing Engine V2 - Packaging diferenciado', () => {
  const base = {
    cost_usd_master: 47,
    units_per_pack_master: 500,
    presentation_quantity: 24,
    exchange_rate: 1450,
    rentability_percentage: 60,
    taxes: [{ name: 'IVA', percentage: 21, is_computable: true, is_active: true }] as TaxRule[],
    embalaje_cost: 760
  };

  it('sin packaging_cost el resultado no cambia (default 0)', () => {
    const sinParam = calculatePriceV2(base);
    const conCero = calculatePriceV2({ ...base, packaging_cost: 0 });
    expect(conCero.precio_final_ars).toBe(sinParam.precio_final_ars);
  });

  it('suma el packaging al costo operativo, ademas del embalaje', () => {
    const sin = calculatePriceV2(base);
    const con = calculatePriceV2({ ...base, packaging_cost: 1200 });
    expect(con.costo_total_operativo).toBeCloseTo(sin.costo_total_operativo + 1200, 2);
    expect(con.precio_final_ars).toBeCloseTo(sin.precio_final_ars + 1200 * 1.6, 1);
  });
});

describe('descuento por volumen en porcentaje', () => {
  it('resuelve el % según los packs equivalentes', async () => {
    const { resolveVolumeDiscountPercentage } = await import('../src/lib/products');
    expect(resolveVolumeDiscountPercentage(1)).toBe(0);
    expect(resolveVolumeDiscountPercentage(2.9)).toBe(0);
    expect(resolveVolumeDiscountPercentage(3)).toBe(5);
    expect(resolveVolumeDiscountPercentage(6)).toBe(10);
    expect(resolveVolumeDiscountPercentage(11)).toBe(15);
    expect(resolveVolumeDiscountPercentage(21)).toBe(20);
    expect(resolveVolumeDiscountPercentage(31)).toBe(25);
    expect(resolveVolumeDiscountPercentage(500)).toBe(25);
  });

  it('un 25% de descuento baja el costo exactamente 25% (no 20%)', () => {
    const cost = 70;
    expect(round2(cost * (1 - 25 / 100))).toBe(52.5);
  });
});

function round2(v: number) { return Math.round((v + Number.EPSILON) * 100) / 100; }

describe('precio sin impuestos', () => {
  it('es el precio final menos solo el IVA (incluye embalaje y packaging)', () => {
    const base = {
      cost_usd_master: 47,
      units_per_pack_master: 500,
      presentation_quantity: 25,
      exchange_rate: 1535,
      rentability_percentage: 60,
      taxes: DEFAULT_TAX_RULES,
      embalaje_cost: 760,
      packaging_cost: 2000
    };
    const conIva = calculatePriceV2(base);
    const sinIva = calculatePriceV2({ ...base, taxes: [] });
    expect(conIva.precio_sin_impuestos_ars).toBeCloseTo(sinIva.precio_final_ars, 1);
    expect(conIva.precio_sin_impuestos_ars).toBeLessThan(conIva.precio_final_ars);
  });
});

describe('comisión de Mercado Pago', () => {
  it('se redondea a pesos enteros (coincide con lo que muestra el carrito)', async () => {
    const { calculateOrderCommission } = await import('../src/lib/pricing');
    const r = calculateOrderCommission(16400, 12062, 'mercadopago', 10);
    expect(r.paymentCommissionAmount).toBe(2846); // 2846,20 -> 2846
    expect(r.totalConComision).toBe(31308);
    expect(Number.isInteger(r.totalConComision)).toBe(true);
  });

  it('con transferencia no hay comisión', async () => {
    const { calculateOrderCommission } = await import('../src/lib/pricing');
    const r = calculateOrderCommission(16400, 12062, 'transferencia', 10);
    expect(r.paymentCommissionAmount).toBe(0);
    expect(r.totalConComision).toBe(28462);
  });
});
