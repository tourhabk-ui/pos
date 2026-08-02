/**
 * Самолечение MAX-бота Кузьмича (/api/cron/max-webhook).
 *
 * Бот в MAX живёт только на webhook-подписке. Один раз она потерялась — и бот
 * замолчал на месяц без единого сигнала. Этот эндпоинт держит подписку живой.
 * Сторож фиксирует контракт: не трогать, если подписка на месте; регистрировать
 * заново, если её нет; закрыт cron-секретом.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const WEBHOOK = 'https://vedarai.ru/api/max/kuzmich';

async function callRoute() {
  const { GET } = await import('@/app/api/cron/max-webhook/route');
  const req = new Request('https://vedarai.ru/api/cron/max-webhook', {
    headers: { authorization: 'Bearer test-secret' },
  });
  return GET(req);
}

describe('/api/cron/max-webhook — самолечение подписки', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRON_SECRET = 'test-secret';
    process.env.MAX_BOT_TOKEN = 'max-token';
    process.env.NEXT_PUBLIC_BASE_URL = 'https://vedarai.ru';
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('401 без валидного cron-секрета', async () => {
    const { GET } = await import('@/app/api/cron/max-webhook/route');
    const res = await GET(new Request('https://vedarai.ru/api/cron/max-webhook'));
    expect(res.status).toBe(401);
  });

  it('подписка на месте → noop, повторно не регистрирует', async () => {
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (!opts || opts.method === 'GET' || opts.method === undefined) {
        return new Response(JSON.stringify({ subscriptions: [{ url: WEBHOOK }] }), { status: 200 });
      }
      throw new Error('POST не должен вызываться, когда подписка уже есть');
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('noop');
    // ровно один вызов — только GET-проверка, без POST-регистрации
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('подписки нет → регистрирует заново', async () => {
    let posted = false;
    const fetchMock = vi.fn(async (_url: string, opts?: { method?: string }) => {
      if (opts?.method === 'POST') {
        posted = true;
        return new Response(JSON.stringify({ success: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ subscriptions: [] }), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const res = await callRoute();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.action).toBe('registered');
    expect(posted).toBe(true);
  });

  it('нет MAX_BOT_TOKEN → 500, не молчит зелёным', async () => {
    delete process.env.MAX_BOT_TOKEN;
    const res = await callRoute();
    expect(res.status).toBe(500);
  });
});
