import { describe, it, expect } from 'vitest';
import { calculatePriceV2, DEFAULT_TAX_RULES } from '../src/lib/pricing';

/**
 * Casos de prueba para validación de Pricing Engine V2.
 * Datos de entrada basados en la auditoría de paridad final.
 */
describe('Pricing Engine V2 - Shadow Mode Validation', () => {
  const EXCHANGE_RATE = 1450;
  
  const TEST_PRODUCTS = [
    { name: 'Semillera', cost: 19, units: 960 },
    { name: 'Almaciguera', cost: 48, units: 600 },
    { name: 'Olivo', cost: 47, units: 500 },
    { name: 'Floral', cost: 58, units: 300 },
    { name: 'Floral 11', cost: 70, units: 100 }
  ];

  describe('Tenant: Integrales (Rentabilidad 20%)', () => {
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
