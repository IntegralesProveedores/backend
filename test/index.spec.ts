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

	it('rejects Mercado Pago webhook with an invalid signature', async () => {
		const context = createExecutionContext();
		const response = await worker.fetch(new IncomingRequest(
			'https://example.com/api/webhooks/mercadopago?data.id=123',
			{
				method: 'POST',
				headers: {
					'x-request-id': 'test-request',
					'x-signature': 'ts=1,v1=invalid'
				}
			}
		), {
			...env,
			MP_ACCESS_TOKEN: 'test-access-token',
			MP_PUBLIC_KEY: 'test-public-key',
			MP_WEBHOOK_SECRET: 'test-webhook-secret'
		}, context);

		expect(response.status).toBe(401);
		await waitOnExecutionContext(context);
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
		expect(data).not.toHaveProperty('tenant');
	});
});
