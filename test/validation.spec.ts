import { SELF, env } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import { buildPricingConfigPayload, DEFAULT_VOLUME_DISCOUNTS } from '../src/lib/products';
import { buildOrderQuote, OrderQuoteError } from '../src/services/order-quote.service';

const pricingConfig = {
  exchangeRate: 1500,
  embalageCost: 760,
  packagingCost: undefined as unknown as number,
  markups: { minorista: 60, mayorista: 30, embalaje: 60 },
  shippingPriceBufferPercentage: 0,
  paymentCommissionPercentage: 10
};

describe('validación de entradas (responden 400, no 500)', () => {
  it('POST /shipping/quote con JSON inválido', async () => {
    const response = await SELF.fetch('https://example.com/shipping/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'esto no es json'
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toBe('Invalid JSON body');
  });

  it('POST /orders con JSON inválido', async () => {
    const response = await SELF.fetch('https://example.com/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{roto'
    });
    expect(response.status).toBe(400);
  });

  it('POST /orders rechaza payment_method distinto de transferencia', async () => {
    const response = await SELF.fetch('https://example.com/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ payment_method: 'mercadopago' })
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toContain('transferencia');
  });

  it('POST /payments/create con JSON inválido', async () => {
    const response = await SELF.fetch('https://example.com/payments/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'null'
    });
    expect(response.status).toBe(400);
  });

  it('POST /orders/abandon exige un external_reference UUID', async () => {
    const post = (body: unknown) => SELF.fetch('https://example.com/orders/abandon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    expect((await post({})).status).toBe(400);
    expect((await post({ external_reference: 'no-es-uuid' })).status).toBe(400);
  });

  it('POST /orders/abandon con una orden inexistente responde cancelled:false', async () => {
    const response = await SELF.fetch('https://example.com/orders/abandon', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ external_reference: '00000000-0000-4000-8000-000000000000' })
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).cancelled).toBe(false);
  });

  it('GET /orders/:id con un id que no es UUID', async () => {
    const response = await SELF.fetch('https://example.com/orders/no-es-un-uuid');
    expect(response.status).toBe(400);
  });
});

describe('/shipping/quote: topes de entrada', () => {
  const productId = 'f426eeae-65a0-409c-98a0-8dd55ed0ea7a';
  const post = (body: unknown) => SELF.fetch('https://example.com/shipping/quote', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  it('rechaza más de 50 ítems', async () => {
    const items = Array.from({ length: 51 }, () => ({ product_id: productId, units: 1 }));
    expect((await post({ postal_code: '1878', items })).status).toBe(400);
  });

  it('rechaza unidades por encima del tope', async () => {
    expect((await post({ postal_code: '1878', items: [{ product_id: productId, units: 1_000_001 }] })).status).toBe(400);
  });
});

describe('precios y envío consistentes', () => {
  it('/categories/:slug/products devuelve los mismos precios que /products', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const category = products[0]?.category?.slug;
    expect(category).toBeTruthy();

    const inCategory = ((await (await SELF.fetch(`https://example.com/categories/${category}/products`)).json()) as any).items;
    expect(inCategory.length).toBeGreaterThan(0);
    for (const item of inCategory) {
      const reference = products.find((p: any) => p.id === item.id);
      expect(reference).toBeTruthy();
      expect(item.variants.map((v: any) => [v.sku, v.price_ars, v.vat_label]))
        .toEqual(reference.variants.map((v: any) => [v.sku, v.price_ars, v.vat_label]));
    }
  });

  it('un pedido con envío a un código postal sin zona se rechaza (no queda gratis)', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const variantId = products[0].variants[0].id;
    await expect(buildOrderQuote(env as any, [{ variant_id: variantId, quantity: 1 }], {
      method: 'delivery',
      address: {
        recipient_name: 'Test', postal_code: '0001', province: 'Buenos Aires', locality: 'X', county: '',
        street: 'Calle', street_number: '1', floor: '', apartment: '', country: 'Argentina'
      }
    })).rejects.toBeInstanceOf(OrderQuoteError);
  });
});

describe('descuento por volumen: el mayor tramo alcanzado se aplica a todo el carrito', () => {
  it('un producto que llega a 3 bultos le da 5% también a los demás', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const olivo = products.find((p: any) => p.slug === 'olivo');
    const floral = products.find((p: any) => p.slug === 'floral');
    const olivo500 = olivo.variants.find((v: any) => v.units_per_pack === 500);   // 3 x 500 = 3 bultos => 5%
    const floral25 = floral.variants.find((v: any) => v.units_per_pack === 25);   // solo, no llega a ningún tramo

    const quote = await buildOrderQuote(env as any, [
      { variant_id: olivo500.id, quantity: 3 },
      { variant_id: floral25.id, quantity: 1 }
    ], { method: 'pickup' });

    expect(quote.items.map(i => i.discount_percentage)).toEqual([5, 5]);

    // El precio del floral coincide con el de la API a una cantidad que da 5% (36 x 25 = 3 bultos).
    const floralConDescuento = ((await (await SELF.fetch('https://example.com/products/floral?quantity=36')).json()) as any)
      .variants.find((v: any) => v.units_per_pack === 25);
    expect(quote.items[1].price_ars).toBe(floralConDescuento.price_ars);

    // Y es más barato que sin descuento.
    const floralSinDescuento = ((await (await SELF.fetch('https://example.com/products/floral?quantity=1')).json()) as any)
      .variants.find((v: any) => v.units_per_pack === 25);
    expect(quote.items[1].price_ars).toBeLessThan(floralSinDescuento.price_ars);
  });

  it('con un solo producto sin tramo alcanzado no hay descuento', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const variant = products[0].variants[0];
    const quote = await buildOrderQuote(env as any, [{ variant_id: variant.id, quantity: 1 }], { method: 'pickup' });
    expect(quote.items[0].discount_percentage).toBe(0);
  });
});

describe('embalaje por caja en el pedido', () => {
  it('3 packs de Almaciguera (1800 u.) + 1 pack de Olivo x25 = 3 cajas grandes + 1 chica, 4 x $1.351', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const almaciguera = products.find((p: any) => p.slug === 'almaciguera').variants.find((v: any) => v.units_per_pack === 600);
    const olivo = products.find((p: any) => p.slug === 'olivo').variants.find((v: any) => v.units_per_pack === 25);

    const quote = await buildOrderQuote(env as any, [
      { variant_id: almaciguera.id, quantity: 3 },
      { variant_id: olivo.id, quantity: 1 }
    ], { method: 'pickup' });

    const cajas = Object.fromEntries(quote.packagingBoxes.map(b => [b.boxModelName, b.count]));
    expect(cajas).toEqual({ 'Caja Grande': 3, 'Caja Chica': 1 });
    expect(quote.embalajeBoxPriceArs).toBe(1351);
    expect(quote.embalajeArs).toBe(4 * 1351);   // con Retiro también se cobra el embalaje
    expect(quote.shippingArs).toBe(0);
  });

  it('POST /packaging/quote devuelve las cajas y el importe', async () => {
    const products = ((await (await SELF.fetch('https://example.com/products')).json()) as any).items;
    const olivo = products.find((p: any) => p.slug === 'olivo');
    const response = await SELF.fetch('https://example.com/packaging/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: [{ product_id: olivo.id, units: 25 }] })
    });
    expect(response.status).toBe(200);
    const data = await response.json() as any;
    expect(data.box_count).toBe(1);
    expect(data.embalaje_ars).toBe(data.embalaje_box_price_ars);
    expect(data.boxes[0].boxModelName).toBe('Caja Chica');
  });

  it('POST /packaging/quote valida la entrada', async () => {
    const post = (body: unknown) => SELF.fetch('https://example.com/packaging/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    expect((await post({})).status).toBe(400);
    expect((await post({ items: [{ product_id: 'x', units: 5 }] })).status).toBe(400);
  });
});

describe('buildPricingConfigPayload', () => {
  it('usa descuentos por defecto y packaging 0 cuando faltan', () => {
    const payload = buildPricingConfigPayload(pricingConfig, [], []);
    expect(payload.volume_discounts.map(d => [d.min, d.discount_percentage]))
      .toEqual(DEFAULT_VOLUME_DISCOUNTS.map(d => [d.min, d.discount_percentage]));
    expect(payload.packaging_cost).toBe(0);
    expect(payload.exchange_rate).toBe(1500);
    expect(payload.markup).toBe(60);
    expect(payload.payment_commission_percentage).toBe(10);
  });

  it('respeta los descuentos de la base cuando existen', () => {
    const discounts = [{ min: 1, discount_percentage: 0 }, { min: 10, discount_percentage: 10 }];
    const payload = buildPricingConfigPayload(pricingConfig, [], discounts).volume_discounts;
    expect(payload.map(d => [d.min, d.discount_percentage])).toEqual([[1, 0], [10, 10]]);
    // `factor` (formato viejo) equivale a dividir el costo: 10% => 1 / 0,9
    expect(payload[1].factor).toBeCloseTo(1.1111, 4);
  });
});
