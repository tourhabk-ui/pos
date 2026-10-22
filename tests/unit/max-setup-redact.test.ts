/**
 * Админка подписки MAX (`/api/max/setup`) не отдаёт ключ подписки — вызовом
 * роута, а не поиском строки в файле.
 *
 * Адрес подписки несёт `?s=<MAX_WEBHOOK_SECRET>`. До 22.10 GET отдавал сырой
 * список подписок MAX рядом с замаскированным `expected_webhook`, то есть
 * ключ стоял в ответе открытым текстом. Ответ админки пересылают снимком или
 * текстом, а с ключом подделанный `bot_started` с `login-<nonce>` — вход в
 * чужой аккаунт (#961).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({ maxFetch: vi.fn() }));
vi.mock('@/lib/max/max-fetch', () => ({ maxFetch: m.maxFetch }));
vi.mock('@/lib/auth/middleware', () => ({ requireAdmin: async () => ({ userId: 'admin-1', role: 'admin' }) }));

const setup = await import('@/app/api/max/setup/route');

const KEY = 'setup-key/with+plus=';
const ENC = encodeURIComponent(KEY);
const KEYED = `https://vedarai.ru/api/max/kuzmich?s=${ENC}`;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const req = (method: string) => new NextRequest('http://localhost/api/max/setup', { method });

beforeEach(() => {
  m.maxFetch.mockReset();
  vi.stubEnv('MAX_BOT_TOKEN', 'bot-token');
  vi.stubEnv('MAX_WEBHOOK_SECRET', KEY);
  vi.stubEnv('NEXT_PUBLIC_BASE_URL', 'https://vedarai.ru');
});
afterEach(() => { vi.unstubAllEnvs(); });

/** Ключа нет ни в каком виде: ни сырым, ни в URL-кодировке. */
function expectNoKey(text: string): void {
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(ENC);
}

describe('/api/max/setup — ответы MAX без ключа подписки', () => {
  it('GET: список подписок показан, ключ в адресе замаскирован', async () => {
    m.maxFetch
      .mockResolvedValueOnce(json({ subscriptions: [
        { url: KEYED, time: 1, update_types: ['message_created'] },
        { url: 'https://other.example/hook', time: 2, update_types: [] },
      ] }))
      .mockResolvedValueOnce(json({ user_id: 1, name: 'Кузьмич' }));
    const res = await setup.GET(req('GET'));
    const body = await res.json();
    const text = JSON.stringify(body);
    expectNoKey(text);
    expect(body.subscriptions.subscriptions[0].url).toBe('https://vedarai.ru/api/max/kuzmich?s=[secret]');
    expect(body.subscriptions.subscriptions[1].url).toBe('https://other.example/hook');
    expect(body.expected_webhook).toBe('https://vedarai.ru/api/max/kuzmich?s=[secret]');
  });

  it('POST: ответ MAX с адресом в сообщении — без ключа', async () => {
    m.maxFetch.mockResolvedValueOnce(json({ success: false, message: `already subscribed: ${KEYED}; raw ${KEY}` }));
    const res = await setup.POST(req('POST'));
    expectNoKey(JSON.stringify(await res.json()));
    // Ключ ушёл в MAX — подписка ставится с ним.
    expect(JSON.parse(String((m.maxFetch.mock.calls[0]![1] as RequestInit).body)).url).toBe(KEYED);
  });

  it('DELETE: ответ MAX — без ключа', async () => {
    m.maxFetch.mockResolvedValueOnce(json({ success: false, message: `no ${KEYED}` }));
    const res = await setup.DELETE(req('DELETE'));
    expectNoKey(JSON.stringify(await res.json()));
  });
});
