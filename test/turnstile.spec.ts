import { describe, it, expect, vi, afterEach } from 'vitest';
import { verifyTurnstile } from '../src/lib/turnstile';

const request = new Request('https://example.com/orders', {
  method: 'POST',
  headers: { 'CF-Connecting-IP': '203.0.113.7' }
});
const env = { TURNSTILE_SECRET_KEY: 'test-secret' };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('verifyTurnstile', () => {
  it('rechaza con 503 si no hay TURNSTILE_SECRET_KEY (falla cerrado)', async () => {
    const response = await verifyTurnstile({}, request, 'token');
    expect(response?.status).toBe(503);
  });

  it('rechaza con 400 si falta el token', async () => {
    expect((await verifyTurnstile(env, request, undefined))?.status).toBe(400);
    expect((await verifyTurnstile(env, request, ''))?.status).toBe(400);
    expect((await verifyTurnstile(env, request, 'x'.repeat(3000)))?.status).toBe(400);
  });

  it('deja pasar si Cloudflare responde success', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true })));
    vi.stubGlobal('fetch', fetchMock);

    expect(await verifyTurnstile(env, request, 'valid-token')).toBeNull();

    const body = fetchMock.mock.calls[0][1].body as FormData;
    expect(body.get('secret')).toBe('test-secret');
    expect(body.get('response')).toBe('valid-token');
    expect(body.get('remoteip')).toBe('203.0.113.7');
  });

  it('rechaza con 400 si Cloudflare responde success:false', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ success: false, 'error-codes': ['invalid-input-response'] }))
    ));
    expect((await verifyTurnstile(env, request, 'bad-token'))?.status).toBe(400);
  });

  it('rechaza con 503 si Cloudflare no responde', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    expect((await verifyTurnstile(env, request, 'token'))?.status).toBe(503);
  });
});
