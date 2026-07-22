import { describe, expect, it } from 'vitest';
import { MercadoPagoService } from '../src/services/mercadopago.service';

describe('Mercado Pago webhook signature', () => {
	it('validates the official HMAC template', async () => {
		const service = new MercadoPagoService('test-access-token');
		const secret = 'test-webhook-secret';
		const requestId = 'test-request-id';
		const dataId = '123456';
		const timestamp = String(Math.floor(Date.now() / 1000));
		const template = `id:${dataId};request-id:${requestId};ts:${timestamp};`;
		const key = await crypto.subtle.importKey(
			'raw',
			new TextEncoder().encode(secret),
			{ name: 'HMAC', hash: 'SHA-256' },
			false,
			['sign']
		);
		const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(template));
		const signature = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');

		expect(await service.validateWebhookSignature(
			`ts=${timestamp},v1=${signature}`,
			requestId,
			dataId,
			secret
		)).toBe(true);
	});

	it('rejects missing or invalid signature data', async () => {
		const service = new MercadoPagoService('test-access-token');

		expect(await service.validateWebhookSignature(null, 'request', '123', 'secret')).toBe(false);
		expect(await service.validateWebhookSignature('ts=1,v1=invalid', 'request', '123', 'secret')).toBe(false);
	});
});
