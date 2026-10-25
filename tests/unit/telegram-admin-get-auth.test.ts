/**
 * GET /api/telegram/admin — только с CRON_SECRET (проверка CRM и каналов 25.10).
 *
 * Edge пускает весь /api/telegram без токена (вебхуки), а GET этого роута
 * исполнял команду владельца по ?command= без единой проверки: testchannels
 * публиковал тестовые посты в публичный канал («Маршрут на кратер открыт»),
 * testpush рассылал push подписчикам, kuzmich и tip — посты канала. Лимит по IP
 * не держал: адрес берётся из X-Forwarded-For, его пишет сам клиент.
 *
 * Сторож — вызов обработчика: без секрета, с неверным, с секретом в адресе и
 * при незаданном CRON_SECRET — 401, и наружу не уходит ни одного запроса;
 * с верным Bearer команда исполняется, ответ уходит владельцу.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

const m = vi.hoisted(() => ({
  query: vi.fn(),
  postRoute: vi.fn(),
  postTip: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock('@/lib/db-pool', () => ({ pool: { query: m.query } }));
vi.mock('@/lib/notifications/telegram-channel', () => ({
  postKuzmichRoute: m.postRoute,
  postKuzmichTip: m.postTip,
}));
vi.mock('@/lib/agents', () => ({ PlatformAgent: { dispatch: vi.fn() } }));
vi.mock('@/lib/ai/providers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/ai/providers')>()),
  callAIWaterfall: vi.fn(async () => 'ответ модели'),
}));

const { GET } = await import('@/app/api/telegram/admin/route');

const SECRET = 'cron-secret-for-tests-25-10';
const OWNER = 4_242;
let ip = 0;

function get(command: string, init: { auth?: string; query?: string } = {}): Promise<Response> {
  const qs = `command=${command}${init.query ? `&${init.query}` : ''}`;
  const headers: Record<string, string> = { 'x-forwarded-for': `10.9.0.${ip++ % 250}` };
  if (init.auth) headers.authorization = init.auth;
  return GET(new NextRequest(`http://localhost/api/telegram/admin?${qs}`, { headers }));
}

/** Запросы наружу: Telegram Bot API, push, модели — всё идёт через fetch или подменённые функции. */
const wentOut = (): boolean =>
  m.fetch.mock.calls.length > 0 || m.postRoute.mock.calls.length > 0 || m.postTip.mock.calls.length > 0;

beforeEach(() => {
  vi.clearAllMocks();
  m.query.mockResolvedValue({ rows: [] });
  m.postRoute.mockResolvedValue({ ok: true, routeId: 'r-1' });
  m.postTip.mockResolvedValue({ ok: true });
  m.fetch.mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
  vi.stubGlobal('fetch', m.fetch);
  vi.stubEnv('TELEGRAM_BOT_TOKEN', 'test-token');
  vi.stubEnv('TELEGRAM_OWNER_ID', String(OWNER));
  vi.stubEnv('CRON_SECRET', SECRET);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('GET админ-бота без CRON_SECRET не исполняет ничего', () => {
  it.each(['testchannels', 'testpush', 'kuzmich', 'tip', 'digest', 'health', 'leads'])(
    'аноним, ?command=%s — 401, наружу ни одного запроса', async (command) => {
      const res = await get(command);
      expect(res.status).toBe(401);
      expect(wentOut()).toBe(false);
      expect(m.query).not.toHaveBeenCalled();
    },
  );

  it('неверный Bearer — 401', async () => {
    const res = await get('kuzmich', { auth: 'Bearer wrong-secret' });
    expect(res.status).toBe(401);
    expect(wentOut()).toBe(false);
  });

  it('секрет в адресе (?secret=) не принимается: он оседает в логах', async () => {
    const res = await get('kuzmich', { query: `secret=${SECRET}` });
    expect(res.status).toBe(401);
    expect(wentOut()).toBe(false);
  });

  it('секрет без слова Bearer — 401', async () => {
    const res = await get('kuzmich', { auth: SECRET });
    expect(res.status).toBe(401);
    expect(wentOut()).toBe(false);
  });

  it('CRON_SECRET на сервере не задан — 401 при любом заголовке', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const res = await get('kuzmich', { auth: 'Bearer ' });
    expect(res.status).toBe(401);
    expect(wentOut()).toBe(false);
  });
});

describe('GET с верным Bearer — команда исполняется владельцу', () => {
  it('?command=kuzmich публикует пост и отвечает владельцу', async () => {
    const res = await get('kuzmich', { auth: `Bearer ${SECRET}` });
    expect(res.status).toBe(200);
    expect(m.postRoute).toHaveBeenCalledTimes(1);
    const to = m.fetch.mock.calls
      .filter(([url]) => String(url).includes('/sendMessage'))
      .map(([, init]) => (JSON.parse(String((init as RequestInit).body)) as { chat_id?: unknown }).chat_id);
    expect(to.length).toBeGreaterThan(0);
    expect(to.every((id) => Number(id) === OWNER)).toBe(true);
  });
});
