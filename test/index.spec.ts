import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Worker Routes Integration Tests', () => {
	it('responds with 404 for unknown route', async () => {
		const response = await SELF.fetch('https://example.com/unknown-route');
		expect(response.status).toBe(404);
		expect(await response.text()).toMatchInlineSnapshot(`"Not Found"`);
	});

	it('GET /settings returns USD exchange rate', async () => {
		const response = await SELF.fetch('https://example.com/settings');
		expect(response.status).toBe(200);
		const data = await response.json() as any;
		expect(data).toHaveProperty('usd_exchange_rate');
		expect(Number(data.usd_exchange_rate)).toBeGreaterThan(0);
	});

	it('GET /products returns list of products', async () => {
		const response = await SELF.fetch('https://example.com/products');
		expect(response.status).toBe(200);
		const data = await response.json() as any;
		expect(data).toHaveProperty('items');
		expect(data).toHaveProperty('pagination');
		expect(data).toHaveProperty('tenant');
		expect(Array.isArray(data.items)).toBe(true);
		
		if (data.items.length > 0) {
			const product = data.items[0];
			expect(product).toHaveProperty('id');
			expect(product).toHaveProperty('name');
			expect(product).toHaveProperty('slug');
			expect(product).toHaveProperty('variants');
			expect(Array.isArray(product.variants)).toBe(true);

			if (product.variants.length > 0) {
				const variant = product.variants[0];
				expect(variant).toHaveProperty('price_ars');
				expect(variant).toHaveProperty('price_usd');
				expect(variant).toHaveProperty('cost_usd');
				expect(variant).toHaveProperty('vat_included');
				expect(variant).toHaveProperty('vat_label');
			}
		}
	});

	it('GET /products with Brotalia tenant header', async () => {
		const response = await SELF.fetch('https://example.com/products', {
			headers: {
				'x-tenant-host': 'brotalia.com.ar'
			}
		});
		expect(response.status).toBe(200);
		const data = await response.json() as any;
		expect(data.tenant.id).toBe('brotalia');
		expect(data.tenant.markup_applied).toBe(40);
	});
});
